"""Tests for adaptive A/V synchronization coordinator."""

from __future__ import annotations

import asyncio
import time

import pytest
from metamorph_engine.protocol import AudioCodec, FrameFlags, Track, VideoCodec
from metamorph_engine.sync import AVSyncCoordinator, SyncedOutputItem


@pytest.mark.asyncio
async def test_single_modality_emits_immediately_without_hold() -> None:
    emitted: list[tuple[SyncedOutputItem, float]] = []

    async def _emit(item: SyncedOutputItem) -> None:
        emitted.append((item, time.monotonic()))

    sync = AVSyncCoordinator(emit_fn=_emit, enabled=True, safety_margin_ms=15.0)
    sync.configure_tracks(voice_active=True, video_active=False)
    sync.start()

    t0 = time.monotonic()
    sync.note_ingress(Track.AUDIO, pts_us=100_000, now_s=t0)
    await sync.submit_output(
        SyncedOutputItem(
            track=Track.AUDIO,
            codec=int(AudioCodec.PCM_S16LE),
            flags=FrameFlags.SPEECH_ACTIVE,
            seq=1,
            pts_us=100_000,
            payload=b"pcm",
            completed_at_s=t0 + 0.01,
        )
    )
    assert len(emitted) == 1
    assert sync.get_telemetry().sync_active is False
    assert sync.get_telemetry().audio_hold_ms == 0.0
    await sync.close()


@pytest.mark.asyncio
async def test_dual_modality_holds_faster_audio_to_match_video_latency() -> None:
    emitted_at: dict[tuple[Track, int], float] = {}
    done_event = asyncio.Event()

    async def _emit(item: SyncedOutputItem) -> None:
        emitted_at[(item.track, item.seq)] = time.monotonic()
        if len(emitted_at) >= 4:
            done_event.set()

    sync = AVSyncCoordinator(
        emit_fn=_emit,
        enabled=True,
        max_hold_s=1.0,
        safety_margin_ms=10.0,
        stale_track_s=2.0,
    )
    sync.configure_tracks(voice_active=True, video_active=True)
    sync.start()

    base = time.monotonic()
    # Frame 1 establishes latencies: video=140ms, audio=15ms
    sync.note_ingress(Track.VIDEO, pts_us=0, now_s=base)
    sync.note_ingress(Track.AUDIO, pts_us=0, now_s=base)

    await sync.submit_output(
        SyncedOutputItem(
            track=Track.VIDEO,
            codec=int(VideoCodec.MJPEG),
            flags=FrameFlags.KEYFRAME,
            seq=1,
            pts_us=0,
            payload=b"v1",
            completed_at_s=base + 0.140,
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
            completed_at_s=base + 0.015,
        )
    )

    # Frame 2 captured at pts=100ms
    now2 = time.monotonic()
    sync.note_ingress(Track.VIDEO, pts_us=100_000, now_s=now2)
    sync.note_ingress(Track.AUDIO, pts_us=100_000, now_s=now2)

    await sync.submit_output(
        SyncedOutputItem(
            track=Track.AUDIO,
            codec=int(AudioCodec.PCM_S16LE),
            flags=FrameFlags.SPEECH_ACTIVE,
            seq=2,
            pts_us=100_000,
            payload=b"a2",
            completed_at_s=now2 + 0.015,
        )
    )
    # Video arrives ~125ms later than audio
    await asyncio.sleep(0.125)
    await sync.submit_output(
        SyncedOutputItem(
            track=Track.VIDEO,
            codec=int(VideoCodec.MJPEG),
            flags=FrameFlags.KEYFRAME,
            seq=2,
            pts_us=100_000,
            payload=b"v2",
            completed_at_s=time.monotonic(),
        )
    )

    await asyncio.wait_for(done_event.wait(), timeout=1.0)
    telemetry = sync.get_telemetry()
    assert telemetry.sync_active is True
    assert telemetry.video_latency_ms > telemetry.audio_latency_ms

    # Audio frame 2 should have been held so its emission aligns close to Video frame 2
    delta_s = abs(emitted_at[(Track.VIDEO, 2)] - emitted_at[(Track.AUDIO, 2)])
    assert delta_s < 0.060, f"Expected A/V emission alignment < 60ms, got {delta_s * 1000:.1f}ms"
    await sync.close()


@pytest.mark.asyncio
async def test_stale_peer_track_releases_hold() -> None:
    emitted: list[SyncedOutputItem] = []

    async def _emit(item: SyncedOutputItem) -> None:
        emitted.append(item)

    sync = AVSyncCoordinator(
        emit_fn=_emit,
        enabled=True,
        stale_track_s=0.15,
    )
    sync.configure_tracks(voice_active=True, video_active=True)
    sync.start()

    t0 = time.monotonic()
    sync.note_ingress(Track.VIDEO, pts_us=0, now_s=t0)
    sync.note_ingress(Track.AUDIO, pts_us=0, now_s=t0)
    await asyncio.sleep(0.20)

    # Only audio continues after video becomes stale
    t1 = time.monotonic()
    sync.note_ingress(Track.AUDIO, pts_us=200_000, now_s=t1)
    await sync.submit_output(
        SyncedOutputItem(
            track=Track.AUDIO,
            codec=int(AudioCodec.PCM_S16LE),
            flags=FrameFlags.NONE,
            seq=1,
            pts_us=200_000,
            payload=b"a",
            completed_at_s=t1 + 0.01,
        )
    )
    assert len(emitted) == 1
    assert sync.get_telemetry().sync_active is False
    await sync.close()
