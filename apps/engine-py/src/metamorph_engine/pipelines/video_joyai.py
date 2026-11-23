"""Real-time JoyAI-Video-Edit (RV2V / V2V) pipeline wrapper."""

from __future__ import annotations

import asyncio
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
from metamorph_engine.pipelines.presence_gate import (
    PresenceGateConfig,
    PresenceGateController,
    build_joyai_detectors,
)
from metamorph_engine.protocol import FrameFlags, VideoCodec


def _decode_jpeg(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as img:
        return img.convert("RGB")


class JoyAIVideoSession(VideoSession):
    """Wraps `JoyOmniV2VStreamingSession` with H.264/MJPEG codec & PTS propagation."""

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
        self._h264_ingest: Any | None = None
        self._h264_stream: Any | None = None
        self._effective_prompt = config.prompt
        self._presence_gate: PresenceGateController | None = None
        self._init_presence_gate(config)
        self._init_inner_session(config, self._ref_image)

    def _presence_gate_config(self, config: VideoSessionConfig) -> PresenceGateConfig:
        s = self._pipeline.settings
        return PresenceGateConfig(
            mode=config.detection_mode,
            face_score_thresh=s.video_face_score_thresh,
            face_min_below_ratio=s.video_face_min_below_ratio,
            face_center_margin=s.video_face_center_margin,
            face_move_eps=s.video_face_move_eps,
            face_settle_drift=s.video_face_settle_drift,
            face_stable_frames=s.video_face_stable_frames,
            person_conf=s.video_person_gate_conf,
            detection_stride=s.video_detection_stride,
            absent_frames=s.video_presence_absent_frames,
            return_frames=s.video_presence_return_frames,
            fail_open_missing_person_model=s.video_gate_fail_open_missing_person_model,
        )

    def _init_presence_gate(self, config: VideoSessionConfig) -> None:
        mods = self._pipeline.require_modules()
        gate_cfg = self._presence_gate_config(config)
        detectors = build_joyai_detectors(
            mods.serving,
            face_onnx=self._pipeline.face_onnx_path,
            person_onnx=self._pipeline.person_onnx_path,
            config=gate_cfg,
        )
        self._presence_gate = PresenceGateController(gate_cfg, detectors)

    def _create_streaming_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None,
        prompt_to_use: str,
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
            output_codec=config.output_codec,
        )

        self._h264_ingest = serving_mod._H264Ingest() if config.input_codec == "h264" else None
        self._h264_stream = (
            serving_mod._H264Stream(config.output_quality)
            if config.output_codec == "h264"
            else None
        )
        self._session = runtime.create_v2v_session(
            prompt=prompt_to_use,
            settings=settings,
            ref_image=ref_image,
        )

    def _init_inner_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None,
    ) -> None:
        mods = self._pipeline.require_modules()
        runtime = mods.runtime
        serving_mod = mods.serving

        prompt_to_use = config.prompt
        if config.use_pe and mods.pe_available(self._pipeline.settings.video_pe_backend):
            try:
                pe_task = "rv2v" if ref_image is not None else "v2v"
                report = asyncio.run(
                    serving_mod._enhance_prompt(
                        raw_prompt=config.prompt,
                        pe_frame=None,
                        pe_model=self._pipeline.settings.video_pe_model,
                        timeout=self._pipeline.settings.video_pe_timeout_s,
                        ref_image=ref_image,
                        backend=self._pipeline.settings.video_pe_backend,
                        pipeline=runtime.pipeline,
                        inference_lock=self._pipeline.infer_lock,
                        task_type=pe_task,
                    )
                )
                enhanced = report.get("enhanced_prompt")
                if isinstance(enhanced, str) and enhanced.strip():
                    prompt_to_use = enhanced.strip()
            except Exception:
                prompt_to_use = config.prompt

        self._effective_prompt = prompt_to_use
        self._create_streaming_session(config, ref_image, prompt_to_use)

    def push_frame(self, frame: VideoFrameIn) -> VideoGateEvent | None:
        with self._lock:
            session = self._session
            if session is None:
                return None

            # Sniff codec from magic bytes to handle browser fallbacks seamlessly
            is_jpeg = frame.payload[:3] == b"\xff\xd8\xff"
            is_annexb = (
                frame.payload[:4] == b"\x00\x00\x00\x01" or frame.payload[:3] == b"\x00\x00\x01"
            )
            if is_jpeg and self._h264_ingest is not None:
                self._h264_ingest = None
            elif is_annexb and self._h264_ingest is None:
                mods = self._pipeline.require_modules()
                self._h264_ingest = mods.serving._H264Ingest()

            if self._h264_ingest is not None:
                image = self._h264_ingest.decode_one(frame.payload)
                if image is None:
                    return None
            else:
                image = _decode_jpeg(frame.payload)

            max_inflight = self._pipeline.settings.video_max_inflight_chunks
            if max_inflight and session.inflight_chunks() >= max_inflight:
                return VideoGateEvent(event_type="dropped", reason="backpressure")

            gate_event: VideoGateEvent | None = None
            if self._presence_gate is not None:
                decision = self._presence_gate.evaluate(image)
                if decision.clear_pending:
                    pending_frames = getattr(session, "pending_frames", None)
                    pending_metas = getattr(session, "pending_metas", None)
                    if isinstance(pending_frames, list):
                        pending_frames.clear()
                    if isinstance(pending_metas, list):
                        pending_metas.clear()
                if decision.reset_session:
                    session.request_stop()
                    session.close(timeout=self._pipeline.settings.video_session_close_timeout_s)
                    self._create_streaming_session(
                        self._config, self._ref_image, self._effective_prompt
                    )
                    session = self._session
                    if session is None:
                        return decision.event
                if not decision.allow_frame:
                    return decision.event
                gate_event = decision.event

            meta = {
                "seq": frame.seq,
                "pts_us": frame.pts_us,
                "t_capture_ms": frame.pts_us / 1000.0,
            }
            with self._pipeline.infer_lock:
                session.push_frame(image, frame_meta=meta, drain_results=False)
            return gate_event

    def poll_outputs(self, timeout: float = 0.05) -> list[VideoFrameOut]:
        with self._lock:
            session = self._session
            h264_stream = self._h264_stream
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
        if h264_stream is not None and not isinstance(items[0], (bytes, bytearray)):
            encoded_packets = h264_stream.encode(items)
            for idx, (wire, is_key) in enumerate(encoded_packets):
                meta = metas[min(idx, len(metas) - 1)]
                pts_us = int(
                    meta.get("pts_us", round(float(meta.get("t_capture_ms", 0.0)) * 1000.0))
                )
                self._out_seq += 1
                flags = FrameFlags.NONE
                if is_key:
                    flags |= FrameFlags.KEYFRAME
                if idx == len(encoded_packets) - 1:
                    flags |= FrameFlags.END_OF_CHUNK
                out_frames.append(
                    VideoFrameOut(
                        payload=wire,
                        codec=VideoCodec.H264_ANNEXB,
                        seq=self._out_seq,
                        pts_us=pts_us,
                        flags=flags,
                    )
                )
        else:
            for idx, raw_jpeg in enumerate(items):
                meta = metas[min(idx, len(metas) - 1)]
                pts_us = int(
                    meta.get("pts_us", round(float(meta.get("t_capture_ms", 0.0)) * 1000.0))
                )
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
            if self._presence_gate is not None:
                self._presence_gate.update_mode(config.detection_mode)
            self._init_inner_session(config, self._ref_image)

    def flush(self) -> None:
        with self._lock:
            session = self._session
        if session is not None:
            with self._pipeline.infer_lock:
                session.flush_pending()

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
        pe_available: Any,
    ) -> None:
        self.runtime = runtime
        self.streaming = streaming
        self.serving = serving
        self.pe_available = pe_available


class JoyAIVideoPipeline(VideoPipeline):
    """JoyAI-Video-Edit streaming RV2V/V2V runtime wrapper."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.infer_lock = threading.Lock()
        self._modules: _JoyAIModules | None = None
        self.face_onnx_path: str = ""
        self.person_onnx_path: str = ""

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
        pe_mod = importlib.import_module("xvideo.serving.pe")

        ckpt_root = deploy_dir / "deps" / "checkpoints"
        self.face_onnx_path = self.settings.video_face_detector_onnx or str(
            ckpt_root / "face_detection_yunet_2023mar.onnx"
        )
        self.person_onnx_path = self.settings.video_person_detector_onnx or str(
            ckpt_root / "yolov8n.onnx"
        )

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

        if self.settings.video_pe_backend == "qwen":
            pe_qwen_mod = importlib.import_module("xvideo.serving.pe_qwen")
            pe_path = self.settings.video_pe_ckpt
            if not pe_path:
                hf_hub = importlib.import_module("huggingface_hub")
                pe_path = hf_hub.snapshot_download(
                    pe_qwen_mod.MODEL_ID,
                    revision=pe_qwen_mod.MODEL_REVISION,
                )
            runtime.pipeline._pe_qwen = pe_qwen_mod.QwenRuntime(
                pe_path, device=self.settings.device
            )

        self._modules = _JoyAIModules(
            runtime=runtime,
            streaming=streaming_mod,
            serving=serving_mod,
            pe_available=pe_mod.pe_available,
        )

    def create_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None = None,
    ) -> VideoSession:
        return JoyAIVideoSession(self, config, ref_image)

    def close(self) -> None:
        self._modules = None
