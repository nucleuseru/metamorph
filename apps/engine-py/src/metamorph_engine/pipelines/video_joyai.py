"""Real-time JoyAI-Video-Edit (RV2V / V2V) pipeline wrapper."""

from __future__ import annotations

import importlib
import io
import os
import sys
import threading
import time
from typing import Any

from PIL import Image

from metamorph_engine.config import EngineSettings
from metamorph_engine.pipelines.base import (
    VideoFrameIn,
    VideoFrameOut,
    VideoGateEvent,
    VideoPipeline,
    VideoSession,
    VideoSessionConfig,
)
from metamorph_engine.protocol import FrameFlags, VideoCodec


def _decode_jpeg(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as img:
        return img.convert("RGB")


class JoyAIVideoSession(VideoSession):
    """Wraps `JoyOmniV2VStreamingSession` with MJPEG codec & PTS propagation."""

    def __init__(
        self,
        pipeline: JoyAIVideoPipeline,
        config: VideoSessionConfig,
        ref_image: Image.Image | None,
    ) -> None:
        self._pipeline = pipeline
        self._config = config
        self._ref_image = ref_image.convert("RGB") if ref_image is not None else None
        self._lock = threading.Lock()
        self._out_seq = 0
        self._session: Any | None = None
        self._create_streaming_session(config, self._ref_image)

    def _create_streaming_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None,
    ) -> None:
        mods = self._pipeline.require_modules()
        runtime = mods.runtime
        streaming_mod = mods.streaming
        serving_mod = mods.serving

        align = int(runtime.pipeline.vae.stem.stride) * 8
        snap = serving_mod._snap_to_align
        height = snap(config.height, align)
        width = snap(config.width, align)

        runtime.output_quality = config.output_quality
        runtime.lossless_output = False

        settings = streaming_mod.StreamingSettings(
            height=height,
            width=width,
            num_inference_steps=config.num_inference_steps,
            seed=config.seed,
            max_temporal_ids=config.max_temporal_ids,
            freeze_kv_on_static=config.freeze_kv_on_static,
            static_diff_thresh=config.static_diff_thresh,
            profile_timings=False,
            output_codec="mjpeg",
        )
        self._session = runtime.create_v2v_session(
            prompt=config.prompt,
            settings=settings,
            ref_image=ref_image,
        )

    def push_frame(self, frame: VideoFrameIn) -> VideoGateEvent | None:
        with self._lock:
            session = self._session
            if session is None:
                return None

            max_inflight = self._pipeline.settings.video_max_inflight_chunks
            if max_inflight and session.inflight_chunks() >= max_inflight:
                return VideoGateEvent(event_type="dropped", reason="backpressure")

            image = _decode_jpeg(frame.payload)
            meta = {
                "seq": frame.seq,
                "pts_us": frame.pts_us,
                "t_capture_ms": frame.pts_us / 1000.0,
            }
            with self._pipeline.infer_lock:
                session.push_frame(image, frame_meta=meta, drain_results=False)
            return None

    def poll_outputs(self, timeout: float = 0.05) -> list[VideoFrameOut]:
        with self._lock:
            session = self._session
        if session is None:
            time.sleep(timeout)
            return []

        try:
            result = session.wait_async_result(timeout=timeout)
        except RuntimeError as exc:
            with self._lock:
                replaced = self._session is not session
            if replaced and "stopped" in str(exc).lower():
                return []
            raise
        if result is None:
            return []

        items = result.jpegs or []
        metas = result.source_metas or [{} for _ in items]
        if result.valid_count is not None:
            items = items[: result.valid_count]
            metas = metas[: result.valid_count]

        if not items:
            return []

        out_frames: list[VideoFrameOut] = []
        total = len(items)
        for idx, raw_jpeg in enumerate(items):
            meta = metas[min(idx, len(metas) - 1)]
            pts_us = int(meta.get("pts_us", round(float(meta.get("t_capture_ms", 0.0)) * 1000.0)))
            self._out_seq += 1
            flags = FrameFlags.KEYFRAME
            if idx == total - 1:
                flags |= FrameFlags.END_OF_CHUNK
            out_frames.append(
                VideoFrameOut(
                    payload=bytes(raw_jpeg),
                    codec=VideoCodec.MJPEG,
                    seq=self._out_seq,
                    pts_us=pts_us,
                    flags=flags,
                )
            )
        return out_frames

    def update_config(self, config: VideoSessionConfig, ref_image: Image.Image | None) -> None:
        with self._lock:
            old = self._session
            self._session = None
            if old is not None:
                old.request_stop()
                old.close(timeout=self._pipeline.settings.video_session_close_timeout_s)
            self._config = config
            self._ref_image = ref_image.convert("RGB") if ref_image is not None else None
            self._create_streaming_session(config, self._ref_image)

    def close(self) -> None:
        with self._lock:
            session = self._session
            self._session = None
        if session is not None:
            session.request_stop()
            session.close(timeout=self._pipeline.settings.video_session_close_timeout_s)


class _JoyAIModules:
    def __init__(
        self,
        *,
        runtime: Any,
        streaming: Any,
        serving: Any,
    ) -> None:
        self.runtime = runtime
        self.streaming = streaming
        self.serving = serving


class JoyAIVideoPipeline(VideoPipeline):
    """JoyAI-Video-Edit streaming RV2V/V2V runtime wrapper."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.infer_lock = threading.Lock()
        self._modules: _JoyAIModules | None = None

    def require_modules(self) -> _JoyAIModules:
        """Return loaded JoyAI runtime & serving modules."""
        if self._modules is None:
            raise RuntimeError("JoyAI video pipeline is not loaded; call warmup() first.")
        return self._modules

    def warmup(self) -> None:
        if self._modules is not None:
            return

        deploy_dir = self.settings.resolved_vendor_dir / "JoyAI-Video-Edit" / "deploy"
        if not deploy_dir.is_dir():
            raise FileNotFoundError(
                f"vendor/JoyAI-Video-Edit/deploy directory not found at {deploy_dir}"
            )
        if str(deploy_dir) not in sys.path:
            sys.path.insert(0, str(deploy_dir))

        try:
            inductor_fix = importlib.import_module("xvideo.inductor_autotune_fix")
            inductor_fix.install()
        except Exception:
            pass

        streaming_mod = importlib.import_module("xvideo.serving.joyomni_streaming")
        serving_mod = importlib.import_module("xvideo.serving.serve_joyomni_streaming")

        ckpt_root = deploy_dir / "deps" / "checkpoints"
        dit_ckpt = self.settings.video_dit_ckpt or str(
            ckpt_root / "JoyAI-Video-Edit" / "dit" / "joyai_video_edit_dit_1101_face++.pth"
        )

        if not self.settings.warmup_on_startup:
            os.environ.setdefault("JOYOMNI_SKIP_LOAD_WARMUP", "1")

        runtime = streaming_mod.JoyOmniRuntime.load(
            dit_ckpt,
            vae_ckpt=self.settings.video_vae_ckpt,
            text_encoder_ckpt=self.settings.video_text_encoder_ckpt,
            device=self.settings.device,
            seed=self.settings.video_seed,
            warmup_height=self.settings.video_height,
            warmup_width=self.settings.video_width,
        )

        self._modules = _JoyAIModules(
            runtime=runtime,
            streaming=streaming_mod,
            serving=serving_mod,
        )

    def create_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None = None,
    ) -> VideoSession:
        return JoyAIVideoSession(self, config, ref_image)

    def close(self) -> None:
        self._modules = None
