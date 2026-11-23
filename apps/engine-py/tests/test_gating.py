"""Tests for upgraded voice VAD, two-phase video presence gate, and sync pause handling."""

from __future__ import annotations

import asyncio
import sys
import time
import types
from typing import Any

import numpy as np
import pytest
from metamorph_engine.config import EngineSettings
from metamorph_engine.pipelines.base import AudioChunkIn, AudioSessionConfig, RmsHangoverVad
from metamorph_engine.pipelines.presence_gate import (
    PresenceGateConfig,
    PresenceGateController,
    PresenceGateDetectors,
)
from metamorph_engine.pipelines.voice_seedvc import SeedVCVoicePipeline, SeedVCVoiceSession
from metamorph_engine.protocol import AudioCodec, FrameFlags, Track, VideoCodec
from metamorph_engine.sync import AVSyncCoordinator, SyncedOutputItem
from PIL import Image


def _tone(amplitude: float, length: int, sr: int = 22050, freq: float = 220.0) -> np.ndarray:
    t = np.arange(length, dtype=np.float32) / float(sr)
    return (amplitude * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)


def test_rms_vad_subframe_peak_catches_late_speech_onset() -> None:
    """20ms sub-frame peak detects speech starting at the end of a 240ms block."""
    sr = 22050
    chunk = np.zeros(5292, dtype=np.float32)
    # Put 20ms of -19.5 dBFS speech only in the trailing 441 samples; whole-block RMS is ~-30.3 dBFS
    chunk[-441:] = _tone(0.15, 441, sr=sr)

    vad = RmsHangoverVad(threshold_db=-25.0, hangover_s=0.0)
    assert vad.is_speech(chunk, sr) is True


def test_rms_vad_adaptive_noise_floor_rejects_steady_hum_and_passes_speech() -> None:
    """Stationary background hum lifts the noise floor without swallowing dynamic speech."""
    sr = 22050
    vad = RmsHangoverVad(
        threshold_db=-45.0,
        hangover_s=0.0,
        adaptive_noise_floor=True,
        noise_margin_db=10.0,
    )
    # Steady -40 dBFS hum across all sub-frames (peak ~= floor)
    hum = _tone(0.01414, 5292, sr=sr, freq=120.0)
    assert vad.is_speech(hum, sr) is False
    assert vad.noise_floor_db is not None and -42.0 <= vad.noise_floor_db <= -38.0
    assert vad.is_speech(hum, sr) is False

    # Dynamic -12 dBFS speech modulates above both threshold and noise floor
    t = np.arange(5292, dtype=np.float32) / float(sr)
    speech = 0.35 * np.sin(2.0 * np.pi * 220.0 * t) * (0.5 + 0.5 * np.sin(2.0 * np.pi * 12.0 * t))
    floor_before = vad.noise_floor_db
    assert vad.is_speech(speech.astype(np.float32), sr) is True
    assert vad.noise_floor_db == floor_before


def test_rms_vad_hangover_handles_short_and_default_durations() -> None:
    """Short hangover <= chunk_s keeps 1 tail block; default 0.3s / 0.24s also keeps 1 tail."""
    sr = 22050
    voiced = _tone(0.2, 5292, sr=sr)
    silent = np.zeros(5292, dtype=np.float32)

    short_vad = RmsHangoverVad(threshold_db=-45.0, hangover_s=0.20)
    assert short_vad.is_speech(voiced, sr) is True
    assert short_vad.is_speech(silent, sr) is True
    assert short_vad.is_speech(silent, sr) is False

    default_vad = RmsHangoverVad(threshold_db=-45.0, hangover_s=0.30)
    assert default_vad.is_speech(voiced, sr) is True
    assert default_vad.is_speech(silent, sr) is True
    assert default_vad.is_speech(silent, sr) is False


def test_seedvc_silero_vad_and_fsmn_deferred_off(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    """Verify Silero 512-sample 16kHz evaluation + FSMN deferred end-of-block turnoff."""
    monkeypatch.setattr(sys, "path", list(sys.path))

    class _FakeScalar:
        def __init__(self, val: float) -> None:
            self._val = val

        def item(self) -> float:
            return self._val

    class _FakeSileroModel:
        def __init__(self) -> None:
            self.window_sizes: list[tuple[int, int]] = []
            self.reset_calls = 0

        def reset_states(self) -> None:
            self.reset_calls += 1

        def __call__(self, tensor_16k: Any, sr: int) -> _FakeScalar:
            arr = tensor_16k.arr
            self.window_sizes.append((int(arr.shape[0]), sr))
            rms = float(np.sqrt(np.mean(np.square(arr))))
            return _FakeScalar(0.9 if rms > 0.05 else 0.05)

    fsmn_queue: list[list[list[int]]] = []

    class _FakeFsmnModel:
        def generate(self, **_kw: Any) -> list[dict[str, Any]]:
            val = fsmn_queue.pop(0) if fsmn_queue else []
            return [{"value": val}]

    silero_model = _FakeSileroModel()
    fsmn_model = _FakeFsmnModel()

    class _Arr:
        def __init__(self, arr: np.ndarray) -> None:
            self.arr = np.asarray(arr)

        def to(self, *_a: Any) -> _Arr:
            return self

        def unsqueeze(self, dim: int) -> _Arr:
            return _Arr(np.expand_dims(self.arr, axis=dim))

        def squeeze(self, dim: int | None = None) -> _Arr:
            return _Arr(np.squeeze(self.arr) if dim is None else np.squeeze(self.arr, axis=dim))

        @property
        def shape(self) -> tuple[int, ...]:
            return self.arr.shape

        def __mul__(self, other: Any) -> _Arr:
            return _Arr(self.arr * (other.arr if isinstance(other, _Arr) else other))

        def __rmul__(self, other: Any) -> _Arr:
            return _Arr((other.arr if isinstance(other, _Arr) else other) * self.arr)

        def __rsub__(self, other: Any) -> _Arr:
            return _Arr((other.arr if isinstance(other, _Arr) else other) - self.arr)

        def __pow__(self, other: Any) -> _Arr:
            return _Arr(self.arr**other)

    class _NoCtx:
        def __enter__(self) -> None:
            return None

        def __exit__(self, *args: object) -> None:
            return None

    fake_torch: Any = types.ModuleType("torch")
    fake_torch.float16 = np.float16
    fake_torch.float32 = np.float32
    fake_torch.no_grad = lambda: _NoCtx()
    fake_torch.from_numpy = lambda arr: _Arr(arr)
    fake_torch.zeros = lambda *s, **kw: _Arr(np.zeros(s[0], dtype=np.float32))
    fake_torch.linspace = lambda a, b, steps=10, **kw: _Arr(np.linspace(a, b, steps))
    fake_torch.sin = lambda t: _Arr(np.sin(t.arr))

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(
        sys.modules,
        "silero_vad",
        types.SimpleNamespace(load_silero_vad=lambda: silero_model),
    )
    monkeypatch.setitem(
        sys.modules,
        "funasr",
        types.SimpleNamespace(AutoModel=lambda **_kw: fsmn_model),
    )

    from metamorph_engine.pipelines.voice_seedvc import _LoadedSeedVC

    settings_silero = EngineSettings(
        backend="gpu",
        enable_voice=True,
        enable_video=False,
        voice_vad_backend="silero",
        voice_vad_hangover_s=0.30,
        voice_vad_silero_threshold=0.5,
        voice_cache_dir=str(tmp_path),
    )
    pipe = SeedVCVoicePipeline(settings_silero)
    pipe._loaded = _LoadedSeedVC(
        torch_mod=fake_torch,
        torchaudio_mod=None,
        torch_f=None,
        device="cpu",
        dtype=np.float32,
        sr=22050,
        hop_length=256,
        model=None,
        semantic_fn=lambda x: x,
        vocoder_fn=lambda x: x,
        campplus_model=lambda x: x,
        to_mel=lambda x: x,
        vad_model=silero_model,
    )
    sess = pipe.create_session(AudioSessionConfig())
    assert isinstance(sess, SeedVCVoiceSession)
    assert silero_model.reset_calls == 1

    voiced = _tone(0.2, 5292)
    silent = np.zeros(5292, dtype=np.float32)
    assert sess._check_speech(voiced) is True
    assert all(w == (512, 16000) for w in silero_model.window_sizes)
    assert sess._check_speech(silent) is True  # 1 hangover block
    assert sess._check_speech(silent) is False
    sess.close()
    assert silero_model.reset_calls == 2

    # FSMN VAD keeps the block containing speech-end active, then turns off on next block
    settings_fsmn = EngineSettings(
        backend="gpu",
        enable_voice=True,
        enable_video=False,
        voice_vad_backend="fsmn",
    )
    pipe_fsmn = SeedVCVoicePipeline(settings_fsmn)
    pipe_fsmn._loaded = _LoadedSeedVC(
        torch_mod=fake_torch,
        torchaudio_mod=None,
        torch_f=None,
        device="cpu",
        dtype=np.float32,
        sr=22050,
        hop_length=256,
        model=None,
        semantic_fn=lambda x: x,
        vocoder_fn=lambda x: x,
        campplus_model=lambda x: x,
        to_mel=lambda x: x,
        vad_model=fsmn_model,
    )
    sess_fsmn = pipe_fsmn.create_session(AudioSessionConfig())
    assert isinstance(sess_fsmn, SeedVCVoiceSession)
    fsmn_queue.extend([[[10, -1]], [[-1, 180]], []])
    assert sess_fsmn._check_speech(voiced) is True
    assert sess_fsmn._check_speech(voiced) is True  # deferred off
    assert sess_fsmn._check_speech(silent) is False
    sess_fsmn.close()

    # Keep unused AudioChunkIn / FrameFlags import usage clear for AudioChunkIn sanity
    assert FrameFlags.SILENCE != FrameFlags.SPEECH_ACTIVE
    assert AudioChunkIn(voiced, 22050, AudioCodec.PCM_S16LE, 1, 0).sample_rate == 22050


def _dummy_img() -> Image.Image:
    return Image.new("RGB", (64, 48), color=(0, 0, 0))


def test_presence_gate_startup_settle_centers_debounces_and_deduplicates_events() -> None:
    """Startup gate requires centering + N still frames and dedups repeated wait events."""
    face_state: dict[str, Any] = {"reason": "no_face", "center": None, "n": 0}
    gate = PresenceGateController(
        PresenceGateConfig(
            mode="near",
            face_stable_frames=3,
            face_center_margin=0.35,
            face_move_eps=0.02,
            face_settle_drift=0.05,
        ),
        PresenceGateDetectors(
            check_face_gate=lambda _img: (
                face_state["reason"],
                face_state["center"],
                face_state["n"],
            ),
            check_full_body_gate=lambda _img, _c: None,
            detect_faces=lambda _img: ([], 64.0, 48.0),
            face_present=lambda *_a: True,
            face_center=lambda *_a: (0.5, 0.5, 0.25),
            person_present=lambda _img: True,
        ),
    )

    d1 = gate.evaluate(_dummy_img())
    assert d1.allow_frame is False
    assert d1.event is not None and d1.event.event_type == "waiting_face"
    assert d1.event.reason == "no_face" and d1.event.emit is True

    # Identical state -> suppressed emit so WS client isn't flooded
    d2 = gate.evaluate(_dummy_img())
    assert d2.allow_frame is False
    assert d2.event is not None and d2.event.emit is False

    # Off-center face -> emits reason="off_center"
    face_state.update({"reason": None, "center": (0.92, 0.5, 0.25), "n": 1})
    d3 = gate.evaluate(_dummy_img())
    assert d3.allow_frame is False
    assert d3.event is not None and d3.event.reason == "off_center" and d3.event.emit is True

    # Centered settle step 1/3
    face_state["center"] = (0.50, 0.50, 0.25)
    d4 = gate.evaluate(_dummy_img())
    assert d4.allow_frame is False
    assert d4.event is not None and d4.event.reason == "settling" and d4.event.emit is True

    # Large jump exceeds move_eps=0.02 -> resets count to 1/3
    face_state["center"] = (0.55, 0.50, 0.25)
    d5 = gate.evaluate(_dummy_img())
    assert d5.allow_frame is False and gate.phase == "settling"

    # Two small steps -> 2/3 then 3/3 -> settled!
    face_state["center"] = (0.555, 0.50, 0.25)
    assert gate.evaluate(_dummy_img()).allow_frame is False
    face_state["center"] = (0.560, 0.50, 0.25)
    d7 = gate.evaluate(_dummy_img())
    assert d7.allow_frame is True and gate.phase == "active"
    assert d7.event is not None and d7.event.event_type == "editing"
    assert d7.event.frame_accepted is True and d7.event.emit is True


def test_presence_gate_mid_session_stride_hysteresis_and_kv_reset_on_return() -> None:
    """Mid-session gate strides detection, debounces absence, and resets KV on return."""
    state: dict[str, Any] = {"present": True, "body": True, "detect_calls": 0}

    def _detect(_img: Image.Image) -> tuple[list[tuple[float, float, float, float]], float, float]:
        state["detect_calls"] += 1
        boxes = [(10.0, 10.0, 20.0, 20.0)] if state["present"] else []
        return boxes, 64.0, 48.0

    gate = PresenceGateController(
        PresenceGateConfig(
            mode="near",
            face_stable_frames=2,
            detection_stride=2,
            absent_frames=3,
            return_frames=2,
            body_flip_frames=2,
        ),
        PresenceGateDetectors(
            check_face_gate=lambda _img: (
                None if state["present"] else "no_face",
                (0.5, 0.5, 0.25) if state["present"] else None,
                1 if state["present"] else 0,
            ),
            check_full_body_gate=lambda _img, _c: None,
            detect_faces=_detect,
            face_present=lambda boxes, *_a: bool(boxes),
            face_center=lambda *_a: (0.5, 0.5, 0.25),
            person_present=lambda _img: state["body"],
        ),
    )

    assert gate.evaluate(_dummy_img()).allow_frame is False
    assert gate.evaluate(_dummy_img()).allow_frame is True
    assert gate.phase == "active"

    # 4 present frames with stride=2 -> only 2 detector calls
    for _ in range(4):
        d = gate.evaluate(_dummy_img())
        assert d.allow_frame is True and d.event is None
    assert state["detect_calls"] == 2

    # 2 missing frames (< absent_frames=3) stay allowed under near hysteresis
    state["present"] = False
    state["body"] = False
    assert gate.evaluate(_dummy_img()).allow_frame is True
    assert gate.evaluate(_dummy_img()).allow_frame is True
    assert gate.phase == "active"

    # 3rd missing frame enters absent_hold, clears pending chunk, emits no_person (body_miss>=2)
    d_hold = gate.evaluate(_dummy_img())
    assert gate.phase == "absent_hold"
    assert d_hold.allow_frame is False
    assert d_hold.clear_pending is True
    assert d_hold.event is not None and d_hold.event.event_type == "no_person"
    assert d_hold.event.emit is True

    # Subsequent absent frame keeps hold silently
    d_hold2 = gate.evaluate(_dummy_img())
    assert (
        d_hold2.allow_frame is False and d_hold2.event is not None and d_hold2.event.emit is False
    )

    # Subject returns: 1st present frame holds (return_frames=2), 2nd resets KV back to settling
    state["present"] = True
    state["body"] = True
    d_ret1 = gate.evaluate(_dummy_img())
    assert d_ret1.allow_frame is False and d_ret1.reset_session is False
    d_ret2 = gate.evaluate(_dummy_img())
    assert d_ret2.allow_frame is False and d_ret2.reset_session is True
    assert gate.phase == "settling"
    assert d_ret2.event is not None and d_ret2.event.event_type == "session_reset"

    # Re-settles cleanly on 2 stable frames
    assert gate.evaluate(_dummy_img()).allow_frame is False
    d_back = gate.evaluate(_dummy_img())
    assert d_back.allow_frame is True and gate.phase == "active"
    assert d_back.event is not None and d_back.event.event_type == "editing"


def test_presence_gate_full_mode_fails_open_when_yolo_missing() -> None:
    """Missing YOLOv8n weights should log once and fail open rather than blocking 100% of frames."""
    gate = PresenceGateController(
        PresenceGateConfig(
            mode="full",
            face_stable_frames=2,
            fail_open_missing_person_model=True,
        ),
        PresenceGateDetectors(
            check_face_gate=lambda _img: (None, (0.5, 0.5, 0.25), 1),
            check_full_body_gate=lambda _img, _c: "full_body_unavailable",
            detect_faces=lambda _img: ([(10.0, 10.0, 20.0, 20.0)], 64.0, 48.0),
            face_present=lambda boxes, *_a: bool(boxes),
            face_center=lambda *_a: (0.5, 0.5, 0.25),
            person_present=lambda _img: True,
        ),
    )

    assert gate.evaluate(_dummy_img()).allow_frame is False
    d2 = gate.evaluate(_dummy_img())
    assert d2.allow_frame is True and gate.phase == "active"
    assert d2.event is not None and d2.event.event_type == "editing"


@pytest.mark.asyncio
async def test_av_sync_releases_audio_hold_when_video_paused_by_gate() -> None:
    """When video is paused by presence gate, audio must emit without video latency hold."""
    emitted: list[tuple[SyncedOutputItem, float]] = []

    async def _emit(item: SyncedOutputItem) -> None:
        emitted.append((item, time.monotonic()))

    sync = AVSyncCoordinator(
        emit_fn=_emit,
        enabled=True,
        max_hold_s=1.0,
        safety_margin_ms=15.0,
        stale_track_s=5.0,
    )
    sync.configure_tracks(voice_active=True, video_active=True)
    sync.start()

    base = time.monotonic()
    sync.note_ingress(Track.VIDEO, pts_us=0, now_s=base)
    sync.note_ingress(Track.AUDIO, pts_us=0, now_s=base)

    # Establish large 200ms video latency vs 10ms audio latency
    await sync.submit_output(
        SyncedOutputItem(
            track=Track.VIDEO,
            codec=int(VideoCodec.MJPEG),
            flags=FrameFlags.KEYFRAME,
            seq=1,
            pts_us=0,
            payload=b"v1",
            completed_at_s=base + 0.20,
        )
    )
    await sync.submit_output(
        SyncedOutputItem(
            track=Track.AUDIO,
            codec=int(AudioCodec.PCM_S16LE),
            flags=FrameFlags.SPEECH_ACTIVE,
            seq=1,
            pts_us=0,
            payload=b"a1",
            completed_at_s=base + 0.01,
        )
    )
    assert sync.get_telemetry().sync_active is True

    # Pause video via gate -> telemetry deactivates and next audio emits with 0 hold
    sync.mark_track_paused(Track.VIDEO)
    assert sync.get_telemetry().sync_active is False

    now2 = time.monotonic()
    sync.note_ingress(Track.AUDIO, pts_us=250_000, now_s=now2)
    await sync.submit_output(
        SyncedOutputItem(
            track=Track.AUDIO,
            codec=int(AudioCodec.PCM_S16LE),
            flags=FrameFlags.SPEECH_ACTIVE,
            seq=2,
            pts_us=250_000,
            payload=b"a2",
            completed_at_s=now2 + 0.01,
        )
    )
    await asyncio.sleep(0.03)
    assert sync.get_telemetry().audio_hold_ms == 0.0
    assert any(item.track == Track.AUDIO and item.seq == 2 for item, _ in emitted)
    await sync.close()
