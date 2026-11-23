"""Session orchestration, asset staging, hot-swapping, and stream workers."""

from __future__ import annotations

import asyncio
import contextlib
import gc
import importlib
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from typing import Any

import numpy as np
from PIL import Image

from metamorph_engine.assets import AssetError, AssetLoader
from metamorph_engine.config import EngineSettings
from metamorph_engine.pipelines.base import (
    AudioChunkIn,
    AudioChunkOut,
    AudioSessionConfig,
    VideoFrameIn,
    VideoFrameOut,
    VideoGateEvent,
    VideoPipeline,
    VideoSession,
    VideoSessionConfig,
    VoicePipeline,
    VoiceSession,
    decode_pcm_bytes,
)
from metamorph_engine.pipelines.mock import MockVideoPipeline, MockVoicePipeline
from metamorph_engine.pipelines.video_joyai import JoyAIVideoPipeline
from metamorph_engine.pipelines.voice_seedvc import SeedVCVoicePipeline
from metamorph_engine.protocol import (
    AudioCodec,
    AudioStartConfig,
    BootstrapStatus,
    ConfigUpdateResponse,
    FrameFlags,
    Modality,
    SessionConfigPatch,
    SyncTelemetry,
    Track,
    VideoCodec,
    VideoStartConfig,
    audio_codec_from_name,
    pack_frame,
)
from metamorph_engine.sync import AVSyncCoordinator, SyncedOutputItem

logger = logging.getLogger("metamorph_engine.session")

DEFAULT_VIDEO_PROMPT = (
    "Keep the person and scene temporally consistent while applying the requested edit."
)


def _release_cuda_cache() -> None:
    """Reclaim transient GPU allocator blocks between pipeline warmups."""
    gc.collect()
    try:
        torch_mod = importlib.import_module("torch")
        if torch_mod.cuda.is_available():
            torch_mod.cuda.empty_cache()
    except Exception:
        pass


class ModalityForbiddenError(PermissionError):
    """Raised when a user targets a modality that is disabled or unauthorized."""


class ActiveStreamSession:
    """Manages one active WebSocket media session (voice, video, or both) with A/V sync."""

    def __init__(
        self,
        *,
        session_id: str,
        settings: EngineSettings,
        voice_pipeline: VoicePipeline | None,
        video_pipeline: VideoPipeline | None,
        voice_config: AudioSessionConfig | None,
        video_config: VideoSessionConfig | None,
        ref_image: Image.Image | None,
        send_bytes_cb: Callable[[bytes], Awaitable[None]],
        send_json_cb: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        self.session_id = session_id
        self._settings = settings
        self._voice_pipeline = voice_pipeline
        self._video_pipeline = video_pipeline
        self.voice_config = voice_config
        self.video_config = video_config
        self.ref_image = ref_image
        self._send_bytes_cb = send_bytes_cb
        self._send_json_cb = send_json_cb

        self.voice_active = voice_pipeline is not None and voice_config is not None
        self.video_active = video_pipeline is not None and video_config is not None

        self._voice_session: VoiceSession | None = None
        self._video_session: VideoSession | None = None

        self._voice_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-worker")
        self._video_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-worker")
        self._voice_in_q: asyncio.Queue[AudioChunkIn | None] = asyncio.Queue(maxsize=32)
        self._video_in_q: asyncio.Queue[tuple[VideoFrameIn, float] | None] = asyncio.Queue(
            maxsize=16
        )

        self._sync = AVSyncCoordinator(
            emit_fn=self._emit_synced_item,
            enabled=settings.av_sync_enabled,
            max_hold_s=settings.av_sync_max_hold_s,
            safety_margin_ms=settings.av_sync_safety_margin_ms,
            stale_track_s=settings.av_sync_stale_track_s,
        )
        self._tasks: list[asyncio.Task[None]] = []
        self._closed = False
        self.frames_in_video = 0
        self.frames_in_audio = 0
        self.frames_out_video = 0
        self.frames_out_audio = 0

    async def start(self) -> None:
        """Create underlying voice/video streaming sessions and launch worker tasks."""
        loop = asyncio.get_running_loop()
        if self.voice_active and self._voice_pipeline is not None and self.voice_config is not None:
            self._voice_session = await loop.run_in_executor(
                self._voice_executor,
                self._voice_pipeline.create_session,
                self.voice_config,
            )
        if self.video_active and self._video_pipeline is not None and self.video_config is not None:
            vid_pipe = self._video_pipeline
            v_cfg = self.video_config
            r_img = self.ref_image
            self._video_session = await loop.run_in_executor(
                self._video_executor,
                lambda: vid_pipe.create_session(v_cfg, r_img),
            )

        self._sync.configure_tracks(voice_active=self.voice_active, video_active=self.video_active)
        self._sync.start()

        if self._voice_session is not None:
            self._tasks.append(
                asyncio.create_task(self._voice_worker_loop(), name="ws-voice-worker")
            )
        if self._video_session is not None:
            self._tasks.append(
                asyncio.create_task(self._video_ingest_loop(), name="ws-video-ingest")
            )
            self._tasks.append(
                asyncio.create_task(self._video_egress_loop(), name="ws-video-egress")
            )
        self._tasks.append(asyncio.create_task(self._telemetry_loop(), name="ws-sync-telemetry"))

    async def submit_binary_frame(
        self,
        *,
        track: Track,
        codec: int,
        flags: FrameFlags,
        seq: int,
        pts_us: int,
        payload: memoryview,
    ) -> None:
        """Route an incoming binary frame to the matching modality queue without blocking."""
        if self._closed:
            return
        now_s = time.monotonic()

        if track == Track.VIDEO:
            if not self.video_active or self._video_session is None:
                await self._send_json_cb(
                    {"type": "error", "message": "Video modality is not active in this session."}
                )
                return
            self.frames_in_video += 1
            v_frame = VideoFrameIn(
                payload=bytes(payload),
                codec=VideoCodec(codec),
                seq=seq,
                pts_us=pts_us,
                flags=flags,
            )
            if self._video_in_q.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    self._video_in_q.get_nowait()
            await self._video_in_q.put((v_frame, now_s))
            return

        if track == Track.AUDIO:
            if not self.voice_active or self._voice_session is None or self.voice_config is None:
                await self._send_json_cb(
                    {"type": "error", "message": "Voice modality is not active in this session."}
                )
                return
            self._sync.note_ingress(Track.AUDIO, pts_us, now_s=now_s)
            self.frames_in_audio += 1
            samples = decode_pcm_bytes(payload, AudioCodec(codec))
            a_chunk = AudioChunkIn(
                samples=samples,
                sample_rate=self.voice_config.input_sample_rate,
                codec=AudioCodec(codec),
                seq=seq,
                pts_us=pts_us,
                flags=flags,
            )
            if self._voice_in_q.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    self._voice_in_q.get_nowait()
            await self._voice_in_q.put(a_chunk)

    async def hot_swap(
        self,
        *,
        voice_config: AudioSessionConfig | None = None,
        video_config: VideoSessionConfig | None = None,
        ref_image: Image.Image | None = None,
        update_ref_image: bool = False,
        ref_audio: np.ndarray | None = None,
    ) -> None:
        """Apply live configuration/asset changes without interrupting the WebSocket."""
        loop = asyncio.get_running_loop()

        if ref_audio is not None and self._voice_session is not None:
            sr = self._settings.voice_sample_rate
            v_sess = self._voice_session
            await loop.run_in_executor(
                self._voice_executor,
                lambda: v_sess.update_reference_audio(ref_audio, sr),
            )

        if voice_config is not None and self._voice_session is not None:
            self.voice_config = voice_config
            v_sess = self._voice_session
            await loop.run_in_executor(
                self._voice_executor,
                lambda: v_sess.update_config(voice_config),
            )

        if (video_config is not None or update_ref_image) and self._video_session is not None:
            new_v_cfg = video_config if video_config is not None else self.video_config
            new_ref = ref_image if update_ref_image else self.ref_image
            self.video_config = new_v_cfg
            self.ref_image = new_ref
            if new_v_cfg is not None:
                vid_sess = self._video_session
                await loop.run_in_executor(
                    self._video_executor,
                    lambda: vid_sess.update_config(new_v_cfg, new_ref),
                )

    def sync_telemetry(self) -> SyncTelemetry:
        """Return live A/V sync telemetry."""
        return self._sync.get_telemetry()

    async def flush_and_close(self) -> None:
        """Stop worker loops, flush pending buffers, and release pipeline sessions."""
        if self._closed:
            return
        self._closed = True

        with contextlib.suppress(asyncio.QueueFull):
            self._voice_in_q.put_nowait(None)
        with contextlib.suppress(asyncio.QueueFull):
            self._video_in_q.put_nowait(None)

        for task in self._tasks:
            if not task.done():
                task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        await self._sync.close()

        loop = asyncio.get_running_loop()
        if self._voice_session is not None:
            v_sess = self._voice_session
            self._voice_session = None
            await loop.run_in_executor(self._voice_executor, v_sess.close)
        if self._video_session is not None:
            vid_sess = self._video_session
            self._video_session = None
            await loop.run_in_executor(self._video_executor, vid_sess.close)

        self._voice_executor.shutdown(wait=False)
        self._video_executor.shutdown(wait=False)

    async def _emit_synced_item(self, item: SyncedOutputItem) -> None:
        if self._closed:
            return
        wire = pack_frame(
            track=item.track,
            codec=item.codec,
            seq=item.seq,
            pts_us=item.pts_us,
            payload=item.payload,
            flags=item.flags,
        )
        if item.track == Track.VIDEO:
            self.frames_out_video += 1
        else:
            self.frames_out_audio += 1
        await self._send_bytes_cb(wire)

    async def _voice_worker_loop(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            while not self._closed:
                chunk = await self._voice_in_q.get()
                if chunk is None or self._voice_session is None:
                    break
                v_sess = self._voice_session
                outputs: list[AudioChunkOut] = await loop.run_in_executor(
                    self._voice_executor,
                    v_sess.push_audio,
                    chunk,
                )
                done_s = time.monotonic()
                for out in outputs:
                    await self._sync.submit_output(
                        SyncedOutputItem(
                            track=Track.AUDIO,
                            codec=int(out.codec),
                            flags=out.flags,
                            seq=out.seq,
                            pts_us=out.pts_us,
                            payload=out.payload,
                            completed_at_s=done_s,
                        )
                    )
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.exception("Voice worker error: %s", exc)
            if not self._closed:
                await self._send_json_cb({"type": "error", "message": f"Voice error: {exc}"})

    async def _video_ingest_loop(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            while not self._closed:
                item = await self._video_in_q.get()
                if item is None or self._video_session is None:
                    break
                frame, ingress_s = item
                vid_sess = self._video_session
                gate_evt: VideoGateEvent | None = await loop.run_in_executor(
                    self._video_executor,
                    vid_sess.push_frame,
                    frame,
                )
                if gate_evt is None or gate_evt.frame_accepted:
                    self._sync.note_ingress(Track.VIDEO, frame.pts_us, now_s=ingress_s)
                elif gate_evt.event_type in ("waiting_face", "no_person", "session_reset"):
                    self._sync.mark_track_paused(Track.VIDEO)

                if gate_evt is not None and gate_evt.emit and not self._closed:
                    await self._send_json_cb(
                        {
                            "type": gate_evt.event_type,
                            "reason": gate_evt.reason,
                            **gate_evt.details,
                        }
                    )
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.exception("Video ingest worker error: %s", exc)
            if not self._closed:
                await self._send_json_cb({"type": "error", "message": f"Video error: {exc}"})

    async def _video_egress_loop(self) -> None:
        try:
            while not self._closed:
                vid_sess = self._video_session
                if vid_sess is None:
                    break
                outputs: list[VideoFrameOut] = await asyncio.to_thread(vid_sess.poll_outputs, 0.05)
                if not outputs:
                    continue
                done_s = time.monotonic()
                for out in outputs:
                    await self._sync.submit_output(
                        SyncedOutputItem(
                            track=Track.VIDEO,
                            codec=int(out.codec),
                            flags=out.flags,
                            seq=out.seq,
                            pts_us=out.pts_us,
                            payload=out.payload,
                            completed_at_s=done_s,
                        )
                    )
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.exception("Video egress worker error: %s", exc)
            if not self._closed:
                await self._send_json_cb({"type": "error", "message": f"Video error: {exc}"})

    async def _telemetry_loop(self) -> None:
        interval = self._settings.av_sync_stats_interval_s
        try:
            while not self._closed:
                await asyncio.sleep(interval)
                if self._closed:
                    break
                telemetry = self._sync.get_telemetry()
                await self._send_json_cb(
                    {
                        "type": "sync_stats",
                        "frames_in_video": self.frames_in_video,
                        "frames_in_audio": self.frames_in_audio,
                        "frames_out_video": self.frames_out_video,
                        "frames_out_audio": self.frames_out_audio,
                        **telemetry.model_dump(),
                    }
                )
        except asyncio.CancelledError:
            return
        except Exception:
            return


class EngineSessionManager:
    """Owns loaded pipelines, staged reference assets, and active stream lifecycle."""

    def __init__(self, settings: EngineSettings, asset_loader: AssetLoader) -> None:
        self._settings = settings
        self._asset_loader = asset_loader
        self._voice_pipeline: VoicePipeline | None = None
        self._video_pipeline: VideoPipeline | None = None

        self._staged_prompt: str = settings.initial_prompt or DEFAULT_VIDEO_PROMPT
        self._has_custom_prompt: bool = bool(settings.initial_prompt)
        self._staged_ref_image: Image.Image | None = None
        self._staged_ref_audio: np.ndarray | None = None
        self._staged_video_override: VideoStartConfig | None = None
        self._staged_audio_override: AudioStartConfig | None = None

        self._lock = asyncio.Lock()
        self._active_stream: ActiveStreamSession | None = None

    @property
    def active_stream(self) -> ActiveStreamSession | None:
        """Return the currently running WebSocket stream session, if any."""
        return self._active_stream

    @property
    def voice_pipeline(self) -> VoicePipeline | None:
        return self._voice_pipeline

    @property
    def video_pipeline(self) -> VideoPipeline | None:
        return self._video_pipeline

    async def load_and_warmup(self) -> None:
        """Instantiate and warm up enabled modalities (video first to limit peak VRAM)."""
        if self._settings.enable_video:
            self._video_pipeline = (
                MockVideoPipeline(self._settings)
                if self._settings.backend == "mock"
                else JoyAIVideoPipeline(self._settings)
            )
            await asyncio.to_thread(self._video_pipeline.warmup)
            if self._settings.enable_voice and self._settings.backend != "mock":
                await asyncio.to_thread(_release_cuda_cache)

        if self._settings.enable_voice:
            self._voice_pipeline = (
                MockVoicePipeline(self._settings)
                if self._settings.backend == "mock"
                else SeedVCVoicePipeline(self._settings)
            )
            await asyncio.to_thread(self._voice_pipeline.warmup)

    async def bootstrap_assets(self) -> None:
        """Optionally load initial prompt, ref image, and ref audio configured via env."""
        if self._settings.initial_ref_image_url and self._video_pipeline is not None:
            self._staged_ref_image = await self._asset_loader.load_ref_image(
                url=self._settings.initial_ref_image_url
            )
        if self._settings.initial_ref_audio_url and self._voice_pipeline is not None:
            audio = await self._asset_loader.load_ref_audio(
                target_sr=self._settings.voice_sample_rate,
                url=self._settings.initial_ref_audio_url,
            )
            self._staged_ref_audio = audio
            await asyncio.to_thread(
                self._voice_pipeline.set_reference_audio,
                audio,
                self._settings.voice_sample_rate,
            )

    def get_bootstrap_status(self) -> BootstrapStatus:
        """Return summary of staged reference assets and pipeline readiness."""
        preview = self._staged_prompt[:80] if self._has_custom_prompt else None
        return BootstrapStatus(
            has_prompt=self._has_custom_prompt,
            prompt_preview=preview,
            has_ref_image=self._staged_ref_image is not None,
            has_ref_audio=(
                self._staged_ref_audio is not None
                or (self._voice_pipeline is not None and self._voice_pipeline.has_reference_audio)
            ),
            voice_ready=self._voice_pipeline is not None,
            video_ready=self._video_pipeline is not None,
        )

    def get_sync_telemetry(self) -> SyncTelemetry:
        """Return live sync telemetry from active stream or zeroed defaults."""
        if self._active_stream is not None:
            return self._active_stream.sync_telemetry()
        return SyncTelemetry(
            sync_active=False,
            video_latency_ms=0.0,
            audio_latency_ms=0.0,
            target_latency_ms=0.0,
            offset_ms=0.0,
            audio_hold_ms=0.0,
            video_hold_ms=0.0,
        )

    def _build_video_config(self, override: VideoStartConfig | None) -> VideoSessionConfig:
        base = VideoSessionConfig(
            prompt=self._staged_prompt,
            width=self._settings.video_width,
            height=self._settings.video_height,
            fps=self._settings.video_fps,
            num_inference_steps=self._settings.video_num_inference_steps,
            seed=self._settings.video_seed,
            output_quality=self._settings.video_output_quality,
            detection_mode=self._settings.video_detection_mode,
            use_pe=self._settings.video_pe_backend != "none",
            freeze_kv_on_static=self._settings.video_freeze_kv_on_static,
            static_diff_thresh=self._settings.video_static_diff_thresh,
            kv_reset_frames=self._settings.video_kv_reset_frames,
            max_temporal_ids=self._settings.video_max_temporal_ids,
        )
        merged = self._staged_video_override
        for cfg in (merged, override):
            if cfg is None:
                continue
            base = replace(
                base,
                input_codec=cfg.input_codec,
                output_codec=cfg.output_codec,
                width=cfg.width if cfg.width is not None else base.width,
                height=cfg.height if cfg.height is not None else base.height,
                fps=cfg.fps if cfg.fps is not None else base.fps,
                num_inference_steps=(
                    cfg.num_inference_steps
                    if cfg.num_inference_steps is not None
                    else base.num_inference_steps
                ),
                seed=cfg.seed if cfg.seed is not None else base.seed,
                output_quality=(
                    cfg.output_quality if cfg.output_quality is not None else base.output_quality
                ),
                detection_mode=(
                    cfg.detection_mode if cfg.detection_mode is not None else base.detection_mode
                ),
                use_pe=cfg.use_pe if cfg.use_pe is not None else base.use_pe,
                freeze_kv_on_static=(
                    cfg.freeze_kv_on_static
                    if cfg.freeze_kv_on_static is not None
                    else base.freeze_kv_on_static
                ),
                static_diff_thresh=(
                    cfg.static_diff_thresh
                    if cfg.static_diff_thresh is not None
                    else base.static_diff_thresh
                ),
                kv_reset_frames=(
                    cfg.kv_reset_frames if cfg.kv_reset_frames is not None else base.kv_reset_frames
                ),
            )
        return base

    def _build_audio_config(self, override: AudioStartConfig | None) -> AudioSessionConfig:
        base = AudioSessionConfig(
            input_sample_rate=self._settings.voice_sample_rate,
            output_sample_rate=self._settings.voice_sample_rate,
            diffusion_steps=self._settings.voice_diffusion_steps,
            cfg_rate=self._settings.voice_cfg_rate,
            block_time_s=self._settings.voice_block_time_s,
            vad_threshold_db=self._settings.voice_vad_threshold_db,
        )
        for cfg in (self._staged_audio_override, override):
            if cfg is None:
                continue
            base = replace(
                base,
                input_codec=audio_codec_from_name(cfg.input_codec),
                output_codec=audio_codec_from_name(cfg.output_codec),
                input_sample_rate=cfg.input_sample_rate,
                output_sample_rate=cfg.output_sample_rate,
                diffusion_steps=(
                    cfg.diffusion_steps if cfg.diffusion_steps is not None else base.diffusion_steps
                ),
                cfg_rate=cfg.cfg_rate if cfg.cfg_rate is not None else base.cfg_rate,
                block_time_s=(
                    cfg.block_time_s if cfg.block_time_s is not None else base.block_time_s
                ),
                vad_threshold_db=(
                    cfg.vad_threshold_db
                    if cfg.vad_threshold_db is not None
                    else base.vad_threshold_db
                ),
                passthrough=cfg.passthrough,
            )
        return base

    async def apply_config_patch(
        self,
        patch: SessionConfigPatch,
        *,
        authorized_modalities: tuple[Modality, ...],
        ref_image_bytes: bytes | None = None,
        ref_audio_bytes: bytes | None = None,
    ) -> ConfigUpdateResponse:
        """Validate, stage, and hot-swap reference assets & stream parameters."""
        touches_video = any(
            [
                patch.prompt is not None,
                patch.ref_image_url is not None,
                patch.ref_image_base64 is not None,
                patch.clear_ref_image,
                patch.video is not None and patch.video.enabled,
                ref_image_bytes is not None,
            ]
        )
        touches_voice = any(
            [
                patch.ref_audio_url is not None,
                patch.ref_audio_base64 is not None,
                patch.audio is not None and patch.audio.enabled,
                ref_audio_bytes is not None,
            ]
        )

        if touches_video and ("video" not in authorized_modalities or self._video_pipeline is None):
            raise ModalityForbiddenError("Video modality is not enabled or authorized.")
        if touches_voice and ("voice" not in authorized_modalities or self._voice_pipeline is None):
            raise ModalityForbiddenError("Voice modality is not enabled or authorized.")

        if patch.ref_image_url and (patch.ref_image_base64 or ref_image_bytes is not None):
            raise AssetError("Provide only one of ref_image_url, ref_image_base64, or file.")
        if patch.ref_audio_url and (patch.ref_audio_base64 or ref_audio_bytes is not None):
            raise AssetError("Provide only one of ref_audio_url, ref_audio_base64, or file.")

        new_ref_image: Image.Image | None = None
        update_ref_image = False
        if patch.clear_ref_image:
            update_ref_image = True
            new_ref_image = None
        elif (
            ref_image_bytes is not None
            or patch.ref_image_url is not None
            or patch.ref_image_base64 is not None
        ):
            update_ref_image = True
            new_ref_image = await self._asset_loader.load_ref_image(
                url=patch.ref_image_url,
                b64=patch.ref_image_base64,
                raw_bytes=ref_image_bytes,
            )

        new_ref_audio: np.ndarray | None = None
        if (
            ref_audio_bytes is not None
            or patch.ref_audio_url is not None
            or patch.ref_audio_base64 is not None
        ):
            new_ref_audio = await self._asset_loader.load_ref_audio(
                target_sr=self._settings.voice_sample_rate,
                url=patch.ref_audio_url,
                b64=patch.ref_audio_base64,
                raw_bytes=ref_audio_bytes,
            )

        async with self._lock:
            if patch.prompt is not None:
                self._staged_prompt = patch.prompt
                self._has_custom_prompt = True
            if update_ref_image:
                self._staged_ref_image = new_ref_image
            if new_ref_audio is not None:
                self._staged_ref_audio = new_ref_audio
                if self._voice_pipeline is not None:
                    await asyncio.to_thread(
                        self._voice_pipeline.set_reference_audio,
                        new_ref_audio,
                        self._settings.voice_sample_rate,
                    )
            if patch.video is not None:
                self._staged_video_override = patch.video
            if patch.audio is not None:
                self._staged_audio_override = patch.audio

            hot_swapped = False
            if self._active_stream is not None:
                await self._active_stream.hot_swap(
                    voice_config=(
                        self._build_audio_config(patch.audio)
                        if (patch.audio is not None and self._active_stream.voice_active)
                        else None
                    ),
                    video_config=(
                        self._build_video_config(patch.video)
                        if (
                            (
                                patch.prompt is not None
                                or patch.video is not None
                                or update_ref_image
                            )
                            and self._active_stream.video_active
                        )
                        else None
                    ),
                    ref_image=self._staged_ref_image,
                    update_ref_image=update_ref_image,
                    ref_audio=new_ref_audio,
                )
                hot_swapped = True

        return ConfigUpdateResponse(
            ok=True,
            hot_swapped=hot_swapped,
            assets=self.get_bootstrap_status(),
        )

    async def start_stream(
        self,
        *,
        patch: SessionConfigPatch,
        authorized_modalities: tuple[Modality, ...],
        send_bytes_cb: Callable[[bytes], Awaitable[None]],
        send_json_cb: Callable[[dict[str, Any]], Awaitable[None]],
        session_id: str | None = None,
    ) -> ActiveStreamSession:
        """Start or restart the single active stream session."""
        # Validate optional start assets & stage them first (only within allowed modalities)
        await self.apply_config_patch(patch, authorized_modalities=authorized_modalities)

        want_voice = (
            "voice" in authorized_modalities
            and self._voice_pipeline is not None
            and (patch.audio.enabled if patch.audio is not None else True)
        )
        want_video = (
            "video" in authorized_modalities
            and self._video_pipeline is not None
            and (patch.video.enabled if patch.video is not None else True)
        )
        if not want_voice and not want_video:
            raise ValueError("At least one authorized modality must be enabled to start streaming.")

        async with self._lock:
            if self._active_stream is not None:
                old_stream = self._active_stream
                self._active_stream = None
                await old_stream.flush_and_close()

            stream = ActiveStreamSession(
                session_id=session_id or uuid.uuid4().hex,
                settings=self._settings,
                voice_pipeline=self._voice_pipeline if want_voice else None,
                video_pipeline=self._video_pipeline if want_video else None,
                voice_config=self._build_audio_config(patch.audio) if want_voice else None,
                video_config=self._build_video_config(patch.video) if want_video else None,
                ref_image=self._staged_ref_image,
                send_bytes_cb=send_bytes_cb,
                send_json_cb=send_json_cb,
            )
            await stream.start()
            self._active_stream = stream
            return stream

    async def stop_stream(self, stream: ActiveStreamSession | None = None) -> None:
        """Stop the given active stream (or whichever stream is active)."""
        async with self._lock:
            target = stream if stream is not None else self._active_stream
            if target is None:
                return
            if self._active_stream is target:
                self._active_stream = None
        await target.flush_and_close()

    async def shutdown_pipelines(self) -> None:
        """Close active stream and release underlying voice/video model weights."""
        await self.stop_stream(None)
        if self._voice_pipeline is not None:
            await asyncio.to_thread(self._voice_pipeline.close)
            self._voice_pipeline = None
        if self._video_pipeline is not None:
            await asyncio.to_thread(self._video_pipeline.close)
            self._video_pipeline = None
