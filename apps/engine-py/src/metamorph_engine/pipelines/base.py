"""Abstract pipeline interfaces and shared media helpers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from PIL import Image

from metamorph_engine.protocol import (
    AudioCodec,
    FrameFlags,
    VideoCodec,
    VideoCodecName,
)


@dataclass(frozen=True, slots=True)
class AudioSessionConfig:
    """Resolved runtime parameters for a voice conversion stream."""

    input_codec: AudioCodec = AudioCodec.PCM_S16LE
    output_codec: AudioCodec = AudioCodec.PCM_S16LE
    input_sample_rate: int = 22050
    output_sample_rate: int = 22050
    diffusion_steps: int = 10
    cfg_rate: float = 0.7
    block_time_s: float = 0.25
    vad_threshold_db: float = -45.0
    passthrough: bool = False


@dataclass(frozen=True, slots=True)
class VideoSessionConfig:
    """Resolved runtime parameters for a video editing / RV2V stream."""

    prompt: str = (
        "Keep the person and scene temporally consistent while applying the requested edit."
    )
    input_codec: VideoCodecName = "mjpeg"
    output_codec: VideoCodecName = "mjpeg"
    width: int = 840
    height: int = 480
    fps: int = 24
    num_inference_steps: int = 2
    seed: int = 42
    output_quality: int = 60
    freeze_kv_on_static: bool = True
    static_diff_thresh: float = 0.5
    max_temporal_ids: int | None = 8


@dataclass(frozen=True, slots=True)
class AudioChunkIn:
    """Incoming PCM audio block with capture timestamp."""

    samples: np.ndarray
    sample_rate: int
    codec: AudioCodec
    seq: int
    pts_us: int
    flags: FrameFlags = FrameFlags.NONE


@dataclass(frozen=True, slots=True)
class AudioChunkOut:
    """Processed PCM audio block with compensated capture timestamp."""

    payload: bytes
    codec: AudioCodec
    sample_rate: int
    seq: int
    pts_us: int
    flags: FrameFlags = FrameFlags.NONE


@dataclass(frozen=True, slots=True)
class VideoFrameIn:
    """Incoming encoded video frame with capture timestamp."""

    payload: bytes
    codec: VideoCodec
    seq: int
    pts_us: int
    flags: FrameFlags = FrameFlags.NONE


@dataclass(frozen=True, slots=True)
class VideoFrameOut:
    """Processed encoded video frame with preserved capture timestamp."""

    payload: bytes
    codec: VideoCodec
    seq: int
    pts_us: int
    flags: FrameFlags = FrameFlags.NONE


@dataclass(frozen=True, slots=True)
class VideoGateEvent:
    """Non-fatal pipeline backpressure notification to emit as JSON control frame."""

    event_type: Literal["dropped"]
    reason: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
    frame_accepted: bool = False
    emit: bool = True


def decode_pcm_bytes(payload: bytes | memoryview, codec: AudioCodec) -> np.ndarray:
    """Convert raw PCM16 LE bytes into mono float32 samples in [-1, 1]."""
    if codec != AudioCodec.PCM_S16LE:
        raise ValueError(f"Unsupported audio codec: {codec}")
    arr = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
    return np.clip(arr, -1.0, 1.0)


def soft_limit_audio(
    samples: np.ndarray,
    *,
    threshold: float = 0.9,
    ceiling: float = 0.98,
) -> np.ndarray:
    """Apply a transparent soft-knee peak limiter above `threshold` to prevent hard clipping."""
    arr = np.asarray(samples, dtype=np.float32)
    if arr.size == 0 or ceiling <= threshold:
        return arr
    mag = np.abs(arr)
    if not np.any(mag > threshold):
        return arr
    headroom = ceiling - threshold
    limited_mag = np.where(
        mag > threshold,
        threshold + headroom * np.tanh((mag - threshold) / headroom),
        mag,
    )
    return (np.sign(arr) * limited_mag).astype(np.float32, copy=False)


def encode_pcm_bytes(samples: np.ndarray, codec: AudioCodec) -> bytes:
    """Serialize mono float32 samples into PCM16 LE wire bytes."""
    if codec != AudioCodec.PCM_S16LE:
        raise ValueError(f"Unsupported audio codec: {codec}")
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def resample_audio_linear(samples: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    """Resample 1D float32 audio cleanly when sample rates differ."""
    if orig_sr == target_sr or samples.size == 0:
        return samples.astype(np.float32, copy=False)
    out_len = max(1, round(samples.shape[0] * target_sr / orig_sr))
    x_old = np.linspace(0.0, 1.0, num=samples.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=out_len, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


class RmsHangoverVad:
    """Sub-frame peak RMS energy VAD with adaptive noise floor and hangover smoothing."""

    def __init__(
        self,
        threshold_db: float = -45.0,
        hangover_s: float = 0.3,
        *,
        subframe_ms: float = 20.0,
        adaptive_noise_floor: bool = False,
        noise_margin_db: float = 10.0,
        max_noise_floor_db: float = -30.0,
    ) -> None:
        self._threshold_db = threshold_db
        self._hangover_s = hangover_s
        self._subframe_ms = subframe_ms
        self._adaptive_noise_floor = adaptive_noise_floor
        self._noise_margin_db = noise_margin_db
        self._max_noise_floor_db = max_noise_floor_db
        self._remaining_hangover_s = 0.0
        self._noise_floor_db: float | None = None

    @property
    def noise_floor_db(self) -> float | None:
        """Return estimated background noise floor in dBFS, if measured."""
        return self._noise_floor_db

    def update_threshold(self, threshold_db: float) -> None:
        """Update base energy threshold dynamically."""
        self._threshold_db = threshold_db

    def is_speech(self, samples: np.ndarray, sample_rate: int) -> bool:
        """Return True if any sub-frame exceeds threshold or within hangover tail."""
        if samples.size == 0 or sample_rate <= 0:
            return False

        frame_len = max(1, round(sample_rate * self._subframe_ms / 1000.0))
        n_full = samples.shape[0] // frame_len
        subframe_rms: list[float] = []
        if n_full > 0:
            frames = samples[: n_full * frame_len].reshape(n_full, frame_len)
            rms_arr = np.sqrt(np.mean(np.square(frames, dtype=np.float32), axis=1))
            subframe_rms.extend(float(v) for v in rms_arr)
        rem = samples[n_full * frame_len :]
        if rem.size > 0:
            subframe_rms.append(float(np.sqrt(np.mean(np.square(rem, dtype=np.float32)))))

        peak_rms = max(subframe_rms)
        floor_rms = min(subframe_rms)
        peak_db = 20.0 * float(np.log10(max(peak_rms, 1e-7)))
        floor_db = 20.0 * float(np.log10(max(floor_rms, 1e-7)))

        effective_threshold = self._threshold_db
        if (
            self._adaptive_noise_floor
            and self._threshold_db > -85.0
            and self._noise_floor_db is not None
        ):
            capped_floor = min(self._max_noise_floor_db, self._noise_floor_db)
            effective_threshold = max(self._threshold_db, capped_floor + self._noise_margin_db)

        chunk_s = samples.shape[0] / float(sample_rate)
        stationary_hum = (peak_db - floor_db) <= 3.0 and floor_db <= self._max_noise_floor_db
        if (
            self._adaptive_noise_floor
            and floor_db > -120.0
            and (peak_db < effective_threshold or stationary_hum)
        ):
            if self._noise_floor_db is None:
                self._noise_floor_db = floor_db
            else:
                alpha = 0.2 if floor_db < self._noise_floor_db else 0.1
                self._noise_floor_db = (1.0 - alpha) * self._noise_floor_db + alpha * floor_db
            if self._threshold_db > -85.0:
                capped_floor = min(self._max_noise_floor_db, self._noise_floor_db)
                effective_threshold = max(self._threshold_db, capped_floor + self._noise_margin_db)

        if peak_db >= effective_threshold:
            self._remaining_hangover_s = self._hangover_s
            return True

        if self._remaining_hangover_s >= 0.5 * chunk_s and self._remaining_hangover_s > 0.0:
            self._remaining_hangover_s = max(0.0, self._remaining_hangover_s - chunk_s)
            return True
        self._remaining_hangover_s = 0.0
        return False


class VoiceSession(ABC):
    """Stateful per-connection streaming voice conversion session."""

    @abstractmethod
    def push_audio(self, chunk: AudioChunkIn) -> list[AudioChunkOut]:
        """Process an incoming PCM block and return 0+ converted PCM blocks."""

    @abstractmethod
    def update_config(self, config: AudioSessionConfig) -> None:
        """Hot-update audio session settings."""

    @abstractmethod
    def update_reference_audio(self, audio_f32: np.ndarray, sample_rate: int) -> None:
        """Hot-swap target speaker reference waveform."""

    @abstractmethod
    def close(self) -> None:
        """Release per-session buffers."""


class VoicePipeline(ABC):
    """Shared loaded voice conversion models (Seed-VC or mock)."""

    @property
    @abstractmethod
    def has_reference_audio(self) -> bool:
        """Return True if a reference voice waveform has been staged."""

    @abstractmethod
    def warmup(self) -> None:
        """Load weights and run startup GPU warmup."""

    @abstractmethod
    def set_reference_audio(self, audio_f32: np.ndarray, sample_rate: int) -> None:
        """Stage or replace reference voice audio on the pipeline."""

    @abstractmethod
    def create_session(self, config: AudioSessionConfig) -> VoiceSession:
        """Create a new streaming session."""

    @abstractmethod
    def close(self) -> None:
        """Release model resources."""


class VideoSession(ABC):
    """Stateful per-connection streaming video editing / RV2V session."""

    @abstractmethod
    def push_frame(self, frame: VideoFrameIn) -> VideoGateEvent | None:
        """Submit an incoming encoded frame; optionally returns a gate/status event."""

    @abstractmethod
    def poll_outputs(self, timeout: float = 0.05) -> list[VideoFrameOut]:
        """Wait briefly for processed video frames ready for transmission."""

    @abstractmethod
    def update_config(self, config: VideoSessionConfig, ref_image: Image.Image | None) -> None:
        """Hot-swap prompt, reference image, or streaming video settings."""

    @abstractmethod
    def close(self) -> None:
        """Stop worker threads and free session KV caches."""


class VideoPipeline(ABC):
    """Shared loaded video editing / RV2V runtime (JoyAI-Video-Edit or mock)."""

    @abstractmethod
    def warmup(self) -> None:
        """Load weights, compile graphs, and warm up CUDA paths."""

    @abstractmethod
    def create_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None = None,
    ) -> VideoSession:
        """Create a new streaming video session."""

    @abstractmethod
    def close(self) -> None:
        """Release model resources."""
