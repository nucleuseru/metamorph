"""Tests for EngineSessionManager pipeline load/warmup ordering."""

from __future__ import annotations

from typing import ClassVar

import pytest
from metamorph_engine import session as session_mod
from metamorph_engine.assets import AssetLoader
from metamorph_engine.config import EngineSettings
from metamorph_engine.session import EngineSessionManager


class _FakeVideoPipeline:
    events: ClassVar[list[str]] = []

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings

    def warmup(self) -> None:
        type(self).events.append("video.warmup")

    def create_session(self, config, ref_image=None):  # pragma: no cover - stub
        raise NotImplementedError

    def close(self) -> None:
        pass


class _FakeVoicePipeline:
    events: ClassVar[list[str]] = []

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.has_reference_audio = False

    def warmup(self) -> None:
        type(self).events.append("voice.warmup")

    def set_reference_audio(self, audio_f32, sample_rate: int) -> None:
        self.has_reference_audio = True

    def create_session(self, config):  # pragma: no cover - stub
        raise NotImplementedError

    def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_gpu_dual_modality_warms_video_then_releases_cache_then_voice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    _FakeVideoPipeline.events = events
    _FakeVoicePipeline.events = events

    monkeypatch.setattr(session_mod, "JoyAIVideoPipeline", _FakeVideoPipeline)
    monkeypatch.setattr(session_mod, "SeedVCVoicePipeline", _FakeVoicePipeline)
    monkeypatch.setattr(session_mod, "_release_cuda_cache", lambda: events.append("release_cache"))

    settings = EngineSettings(
        backend="gpu",
        enable_voice=True,
        enable_video=True,
    )
    mgr = EngineSessionManager(settings, AssetLoader(settings))
    await mgr.load_and_warmup()

    assert events == ["video.warmup", "release_cache", "voice.warmup"]
    assert mgr.video_pipeline is not None
    assert mgr.voice_pipeline is not None


@pytest.mark.asyncio
async def test_single_modality_and_mock_skip_cuda_cache_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    _FakeVideoPipeline.events = events
    _FakeVoicePipeline.events = events

    monkeypatch.setattr(session_mod, "JoyAIVideoPipeline", _FakeVideoPipeline)
    monkeypatch.setattr(session_mod, "SeedVCVoicePipeline", _FakeVoicePipeline)
    monkeypatch.setattr(session_mod, "_release_cuda_cache", lambda: events.append("release_cache"))

    # Video-only GPU should not call cache release between modalities
    video_only = EngineSettings(backend="gpu", enable_voice=False, enable_video=True)
    mgr_video = EngineSessionManager(video_only, AssetLoader(video_only))
    await mgr_video.load_and_warmup()
    assert events == ["video.warmup"]

    # Mock dual-modality should not call _release_cuda_cache
    events.clear()
    mock_dual = EngineSettings(backend="mock", enable_voice=True, enable_video=True)
    mgr_mock = EngineSessionManager(mock_dual, AssetLoader(mock_dual))
    await mgr_mock.load_and_warmup()
    assert "release_cache" not in events
    assert mgr_mock.video_pipeline is not None
    assert mgr_mock.voice_pipeline is not None
