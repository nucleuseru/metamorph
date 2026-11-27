"""CPU-friendly mock pipelines for testing and local non-GPU development."""

from __future__ import annotations

import contextlib
import io
import queue
import threading
import time

import numpy as np
from PIL import Image, ImageDraw

from metamorph_engine.config import EngineSettings
from metamorph_engine.pipelines.base import (
    AudioChunkIn,
    AudioChunkOut,
    AudioSessionConfig,
    RmsHangoverVad,
    VideoFrameIn,
    VideoFrameOut,
    VideoGateEvent,
    VideoPipeline,
    VideoSession,
    VideoSessionConfig,
    VoicePipeline,
    VoiceSession,
    encode_pcm_bytes,
    resample_audio_linear,
)
from metamorph_engine.protocol import FrameFlags, VideoCodec


class MockVoiceSession(VoiceSession):
    """Simulates Seed-VC block buffering, VAD, lookahead PTS, and voice transformation."""

    def __init__(self, pipeline: MockVoicePipeline, config: AudioSessionConfig) -> None:
        self._pipeline = pipeline
        self._config = config
        self._model_sr = pipeline.settings.voice_sample_rate
        self._zc = max(1, self._model_sr // 50)
        self._block_samples = max(
            self._zc,
            round(config.block_time_s * self._model_sr / self._zc) * self._zc,
        )
        self._lookahead_us = round(pipeline.settings.voice_extra_context_right_s * 1_000_000)
        self._vad = RmsHangoverVad(
            threshold_db=config.vad_threshold_db,
            hangover_s=pipeline.settings.voice_vad_hangover_s,
            adaptive_noise_floor=pipeline.settings.voice_vad_adaptive_noise_floor,
            noise_margin_db=pipeline.settings.voice_vad_noise_margin_db,
        )
        self._buffer = np.zeros(0, dtype=np.float32)
        self._buffer_start_pts_us: int | None = None
        self._out_seq = 0

    def push_audio(self, chunk: AudioChunkIn) -> list[AudioChunkOut]:
        samples = resample_audio_linear(chunk.samples, chunk.sample_rate, self._model_sr)
        if samples.size == 0:
            return []
        if self._buffer.size == 0:
            self._buffer_start_pts_us = chunk.pts_us
        self._buffer = np.concatenate([self._buffer, samples])

        outputs: list[AudioChunkOut] = []
        block_dur_us = round(self._block_samples * 1_000_000 / self._model_sr)

        while self._buffer.shape[0] >= self._block_samples:
            block = self._buffer[: self._block_samples]
            self._buffer = self._buffer[self._block_samples :]

            latency_s = self._pipeline.settings.mock_audio_latency_ms / 1000.0
            if latency_s > 0.0:
                time.sleep(latency_s)

            block_pts = (
                self._buffer_start_pts_us if self._buffer_start_pts_us is not None else chunk.pts_us
            )
            if self._buffer.size > 0 and self._buffer_start_pts_us is not None:
                self._buffer_start_pts_us += block_dur_us
            else:
                self._buffer_start_pts_us = None

            out_pts = max(0, block_pts - self._lookahead_us)
            flags = FrameFlags.NONE
            if self._config.passthrough or not self._pipeline.has_reference_audio:
                out_samples = block
                if self._config.passthrough:
                    flags |= FrameFlags.PASSTHROUGH
            elif self._pipeline.settings.voice_vad_backend != "none" and not self._vad.is_speech(
                block, self._model_sr
            ):
                out_samples = np.zeros_like(block)
                flags |= FrameFlags.SILENCE
            else:
                # Deterministic gentle gain modulation seeded by reference audio mean
                gain = self._pipeline.reference_gain
                out_samples = np.clip(block * gain, -1.0, 1.0)
                flags |= FrameFlags.SPEECH_ACTIVE

            out_resampled = resample_audio_linear(
                out_samples,
                self._model_sr,
                self._config.output_sample_rate,
            )
            self._out_seq += 1
            outputs.append(
                AudioChunkOut(
                    payload=encode_pcm_bytes(out_resampled, self._config.output_codec),
                    codec=self._config.output_codec,
                    sample_rate=self._config.output_sample_rate,
                    seq=self._out_seq,
                    pts_us=out_pts,
                    flags=flags,
                )
            )
        return outputs

    def update_config(self, config: AudioSessionConfig) -> None:
        self._config = config
        self._vad.update_threshold(config.vad_threshold_db)
        self._block_samples = max(
            self._zc,
            round(config.block_time_s * self._model_sr / self._zc) * self._zc,
        )

    def update_reference_audio(self, audio_f32: np.ndarray, sample_rate: int) -> None:
        self._pipeline.set_reference_audio(audio_f32, sample_rate)

    def close(self) -> None:
        self._buffer = np.zeros(0, dtype=np.float32)


class MockVoicePipeline(VoicePipeline):
    """Zero-GPU mock voice pipeline for fast CPU integration tests."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self._ref_audio: np.ndarray | None = None
        self._ref_gain: float = 0.95
        self._warmed = False

    @property
    def has_reference_audio(self) -> bool:
        return self._ref_audio is not None

    @property
    def reference_gain(self) -> float:
        return self._ref_gain

    def warmup(self) -> None:
        self._warmed = True

    def set_reference_audio(self, audio_f32: np.ndarray, sample_rate: int) -> None:
        resampled = resample_audio_linear(audio_f32, sample_rate, self.settings.voice_sample_rate)
        self._ref_audio = resampled
        energy = float(np.mean(np.abs(resampled))) if resampled.size else 0.0
        self._ref_gain = max(0.5, min(1.0, 0.8 + energy * 0.2))

    def create_session(self, config: AudioSessionConfig) -> VoiceSession:
        return MockVoiceSession(self, config)

    def close(self) -> None:
        self._ref_audio = None


class MockVideoSession(VideoSession):
    """Simulates JoyAI-Video-Edit chunking (1 frame then N frames) & RV2V output."""

    def __init__(
        self,
        pipeline: MockVideoPipeline,
        config: VideoSessionConfig,
        ref_image: Image.Image | None,
    ) -> None:
        self._pipeline = pipeline
        self._config = config
        self._ref_image = ref_image
        self._chunk_size = max(1, pipeline.settings.mock_video_chunk_frames)
        self._chunk_idx = 0
        self._pending: list[VideoFrameIn] = []
        self._in_queue: queue.Queue[list[VideoFrameIn] | None] = queue.Queue(maxsize=8)
        self._out_queue: queue.Queue[VideoFrameOut] = queue.Queue()
        self._closed = threading.Event()
        self._out_seq = 0
        self._worker = threading.Thread(target=self._worker_loop, name="mock-video", daemon=True)
        self._worker.start()

    def push_frame(self, frame: VideoFrameIn) -> VideoGateEvent | None:
        if self._closed.is_set():
            return None
        max_inflight = self._pipeline.settings.video_max_inflight_chunks
        if max_inflight and self._in_queue.qsize() >= max_inflight:
            return VideoGateEvent(event_type="dropped", reason="backpressure")

        self._pending.append(frame)
        needed = 1 if self._chunk_idx == 0 else self._chunk_size
        if len(self._pending) >= needed:
            batch = self._pending[:needed]
            del self._pending[:needed]
            self._chunk_idx += 1
            self._in_queue.put(batch)
        return None

    def _worker_loop(self) -> None:
        while not self._closed.is_set():
            try:
                batch = self._in_queue.get(timeout=0.05)
            except queue.Empty:
                continue
            if batch is None:
                return
            latency_s = self._pipeline.settings.mock_video_latency_ms / 1000.0
            if latency_s > 0.0:
                time.sleep(latency_s)

            total = len(batch)
            for idx, frame in enumerate(batch):
                self._out_seq += 1
                flags = FrameFlags.NONE
                if idx == 0:
                    flags |= FrameFlags.KEYFRAME
                if idx == total - 1:
                    flags |= FrameFlags.END_OF_CHUNK

                payload = self._render_mock_frame(frame)
                self._out_queue.put(
                    VideoFrameOut(
                        payload=payload,
                        codec=VideoCodec.MJPEG,
                        seq=self._out_seq,
                        pts_us=frame.pts_us,
                        flags=flags,
                    )
                )

    def _render_mock_frame(self, frame: VideoFrameIn) -> bytes:
        # Render or re-encode a clean small JPEG
        if frame.payload[:3] == b"\xff\xd8\xff":
            try:
                with Image.open(io.BytesIO(frame.payload)) as im:
                    img = im.convert("RGB")
            except Exception:
                img = Image.new("RGB", (64, 48), color=(30, 60, 90))
        else:
            img = Image.new("RGB", (64, 48), color=(30, 60, 90))
        draw = ImageDraw.Draw(img)
        if self._ref_image is not None:
            draw.rectangle((0, 0, 8, 8), fill=(0, 220, 120))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=max(10, min(95, self._config.output_quality)))
        return buf.getvalue()

    def poll_outputs(self, timeout: float = 0.05) -> list[VideoFrameOut]:
        items: list[VideoFrameOut] = []
        try:
            items.append(self._out_queue.get(timeout=timeout))
        except queue.Empty:
            return items
        while True:
            try:
                items.append(self._out_queue.get_nowait())
            except queue.Empty:
                break
        return items

    def update_config(self, config: VideoSessionConfig, ref_image: Image.Image | None) -> None:
        self._config = config
        self._ref_image = ref_image

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        with contextlib.suppress(queue.Full):
            self._in_queue.put_nowait(None)
        self._worker.join(timeout=2.0)


class MockVideoPipeline(VideoPipeline):
    """Zero-GPU mock video pipeline for fast CPU integration tests."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self._warmed = False

    def warmup(self) -> None:
        self._warmed = True

    def create_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None = None,
    ) -> VideoSession:
        return MockVideoSession(self, config, ref_image)

    def close(self) -> None:
        self._warmed = False
