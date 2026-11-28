"""Abstract pipeline interfaces and shared media helpers."""

from __future__ import annotations

import importlib
import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from PIL import Image

from metamorph_engine.protocol import (
    AudioCodec,
    FrameFlags,
    ProtocolError,
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
    diffusion_steps: int = 20
    cfg_rate: float = 0.7
    block_time_s: float = 0.32
    vad_threshold_db: float = -48.0
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
    nbytes = memoryview(payload).nbytes
    if nbytes % 2 != 0:
        raise ProtocolError(
            f"Invalid PCM_S16LE payload length ({nbytes} bytes); expected even byte count."
        )
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


def resample_audio_hq(samples: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    """Anti-aliased polyphase resampler (scipy when available, linear fallback otherwise)."""
    arr = np.asarray(samples, dtype=np.float32)
    if orig_sr == target_sr or arr.size == 0:
        return arr
    try:
        scipy_signal = importlib.import_module("scipy.signal")
    except ImportError:
        return resample_audio_linear(arr, orig_sr, target_sr)
    divisor = math.gcd(orig_sr, target_sr)
    up = target_sr // divisor
    down = orig_sr // divisor
    resampled = scipy_signal.resample_poly(arr, up, down)
    return np.clip(np.asarray(resampled, dtype=np.float32), -1.0, 1.0)


def _design_butter4_sos(cutoff_hz: float, sample_rate: int) -> np.ndarray:
    """Compute normalized 4th-order Butterworth low-pass second-order sections."""
    nyquist = 0.5 * sample_rate
    wn = min(max(cutoff_hz / nyquist, 1e-4), 0.99)
    try:
        scipy_signal = importlib.import_module("scipy.signal")
        return np.asarray(
            scipy_signal.butter(4, wn, btype="low", output="sos"),
            dtype=np.float64,
        )
    except ImportError:
        pass

    w0 = math.pi * wn
    cos_w0 = math.cos(w0)
    sin_w0 = math.sin(w0)
    sos = np.zeros((2, 6), dtype=np.float64)
    # Q factors for cascaded 2nd-order sections of a 4th-order Butterworth filter
    q_factors = (
        1.0 / (2.0 * math.cos(math.pi / 8.0)),
        1.0 / (2.0 * math.cos(3.0 * math.pi / 8.0)),
    )
    for idx, q_val in enumerate(q_factors):
        alpha = sin_w0 / (2.0 * q_val)
        a0 = 1.0 + alpha
        b0 = ((1.0 - cos_w0) * 0.5) / a0
        b1 = (1.0 - cos_w0) / a0
        sos[idx] = (b0, b1, b0, 1.0, (-2.0 * cos_w0) / a0, (1.0 - alpha) / a0)
    return sos


class StatefulAudioResampler:
    """Phase-continuous streaming resampler with stateful anti-alias / anti-imaging LPF."""

    def __init__(self, orig_sr: int, target_sr: int) -> None:
        if orig_sr <= 0 or target_sr <= 0:
            raise ValueError(f"Sample rates must be positive, got {orig_sr} -> {target_sr}")
        self.orig_sr = orig_sr
        self.target_sr = target_sr
        self._step = orig_sr / target_sr
        self._filter_pre = orig_sr > target_sr
        self._sos: np.ndarray | None = None
        self._zi: np.ndarray | None = None
        if orig_sr != target_sr:
            filter_sr = orig_sr if self._filter_pre else target_sr
            cutoff = 0.45 * min(orig_sr, target_sr)
            self._sos = _design_butter4_sos(cutoff, filter_sr)
            self._zi = np.zeros((self._sos.shape[0], 2), dtype=np.float64)
            try:
                self._scipy_signal: Any | None = importlib.import_module("scipy.signal")
            except ImportError:
                self._scipy_signal = None
        else:
            self._scipy_signal = None
        self._tail = np.zeros(0, dtype=np.float32)
        self._phase = 1.0
        self._started = False

    def reset(self) -> None:
        """Reset continuity and filter state for a new stream."""
        if self._sos is not None:
            self._zi = np.zeros((self._sos.shape[0], 2), dtype=np.float64)
        self._tail = np.zeros(0, dtype=np.float32)
        self._phase = 1.0
        self._started = False

    def _apply_lpf(self, samples: np.ndarray) -> np.ndarray:
        if self._sos is None or self._zi is None or samples.size == 0:
            return samples
        if self._scipy_signal is not None:
            y, zi = self._scipy_signal.sosfilt(
                self._sos,
                samples.astype(np.float64, copy=False),
                zi=self._zi,
            )
            self._zi = np.asarray(zi, dtype=np.float64)
            return np.asarray(y, dtype=np.float32)

        x = samples.astype(np.float64, copy=False)
        for stage in range(self._sos.shape[0]):
            b0, b1, b2, _a0, a1, a2 = self._sos[stage]
            z1 = float(self._zi[stage, 0])
            z2 = float(self._zi[stage, 1])
            y = np.empty_like(x)
            for i in range(x.shape[0]):
                xi = float(x[i])
                yi = b0 * xi + z1
                z1 = b1 * xi - a1 * yi + z2
                z2 = b2 * xi - a2 * yi
                y[i] = yi
            self._zi[stage, 0] = z1
            self._zi[stage, 1] = z2
            x = y
        return x.astype(np.float32)

    def _interpolate_continuous(self, samples: np.ndarray) -> np.ndarray:
        if samples.size == 0:
            return np.zeros(0, dtype=np.float32)
        if not self._started:
            self._tail = np.array([samples[0]], dtype=np.float32)
            self._phase = 1.0
            self._started = True

        buf = np.concatenate((self._tail, samples))
        limit = buf.size - 2
        if limit <= 1 or self._phase >= limit:
            consume = min(buf.size, max(0, math.floor(self._phase) - 1))
            self._tail = buf[consume:].copy()
            self._phase -= consume
            return np.zeros(0, dtype=np.float32)

        count = max(0, math.floor((limit - self._phase) / self._step) + 1)
        while count > 0 and self._phase + (count - 1) * self._step >= limit:
            count -= 1
        while self._phase + count * self._step < limit:
            count += 1

        if count == 0:
            consume = min(buf.size, max(0, math.floor(self._phase) - 1))
            self._tail = buf[consume:].copy()
            self._phase -= consume
            return np.zeros(0, dtype=np.float32)

        positions = self._phase + np.arange(count, dtype=np.float64) * self._step
        i0 = np.floor(positions).astype(np.int64)
        u = (positions - i0).astype(np.float32)
        p0 = buf[i0 - 1]
        p1 = buf[i0]
        p2 = buf[i0 + 1]
        p3 = buf[i0 + 2]
        u2 = u * u
        u3 = u2 * u
        out = 0.5 * (
            (2.0 * p1)
            + (-p0 + p2) * u
            + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u2
            + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * u3
        )
        next_pos = self._phase + count * self._step
        consume = min(buf.size, max(0, math.floor(next_pos) - 1))
        self._tail = buf[consume:].copy()
        self._phase = next_pos - consume
        return np.clip(out.astype(np.float32, copy=False), -1.0, 1.0)

    def process(self, samples: np.ndarray) -> np.ndarray:
        """Resample one sequential chunk while preserving phase and filter state."""
        arr = np.asarray(samples, dtype=np.float32)
        if self.orig_sr == self.target_sr or arr.size == 0:
            return arr
        if self._filter_pre:
            filtered = self._apply_lpf(arr)
            return self._interpolate_continuous(filtered)
        upsampled = self._interpolate_continuous(arr)
        return np.clip(self._apply_lpf(upsampled), -1.0, 1.0)


def prepare_reference_audio(
    samples: np.ndarray,
    sample_rate: int,
    *,
    max_duration_s: float,
    trim_top_db: float = 40.0,
    pad_s: float = 0.05,
    min_trimmed_s: float = 0.5,
    target_peak: float = 0.891,
) -> np.ndarray:
    """Clean a reference speaker clip: trim dead edge silence, remove DC, cap length, normalize."""
    arr = np.asarray(samples, dtype=np.float32).reshape(-1)
    if arr.size == 0 or sample_rate <= 0:
        return arr

    # Trim leading/trailing silence using AC frame RMS (immune to DC offset)
    peak = float(np.max(np.abs(arr)))
    if peak >= 0.003:
        frame_len = max(1, round(sample_rate * 0.02))
        n_frames = arr.size // frame_len
        if n_frames >= 2:
            frames = arr[: n_frames * frame_len].reshape(n_frames, frame_len)
            centered = frames - np.mean(frames, axis=1, keepdims=True)
            frame_rms = np.sqrt(np.mean(np.square(centered, dtype=np.float32), axis=1))
            max_rms = float(np.max(frame_rms))
            if max_rms > 1e-6:
                rms_thresh = max_rms * (10.0 ** (-trim_top_db / 20.0))
                active = np.flatnonzero(frame_rms >= rms_thresh)
                if active.size > 0:
                    pad_samples = round(sample_rate * pad_s)
                    start = max(0, int(active[0]) * frame_len - pad_samples)
                    end = min(arr.size, (int(active[-1]) + 1) * frame_len + pad_samples)
                    if (end - start) >= round(sample_rate * min_trimmed_s):
                        arr = arr[start:end]

    # Remove DC bias on dynamic signals so reference mel spectrograms have no offset
    if float(np.std(arr)) > 1e-6:
        arr = arr - float(np.mean(arr))

    max_samples = max(1, int(sample_rate * max_duration_s))
    if arr.size > max_samples:
        arr = arr[:max_samples]

    # Normalize audible clips to -1 dBFS so quiet reference recordings stay crisp & full-bodied
    post_peak = float(np.max(np.abs(arr))) if arr.size > 0 else 0.0
    if post_peak >= 0.003:
        arr = arr * (target_peak / post_peak)
    return np.clip(arr, -1.0, 1.0).astype(np.float32, copy=False)


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
