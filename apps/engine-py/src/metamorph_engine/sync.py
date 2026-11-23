"""Adaptive audio/video synchronization coordinator using capture PTS."""

from __future__ import annotations

import asyncio
import contextlib
import heapq
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from metamorph_engine.protocol import FrameFlags, SyncTelemetry, Track


@dataclass(frozen=True, slots=True)
class SyncedOutputItem:
    """Processed media output item ready for paced emission."""

    track: Track
    codec: int
    flags: FrameFlags
    seq: int
    pts_us: int
    payload: bytes
    completed_at_s: float


class AVSyncCoordinator:
    """Aligns dual-modality output emission when audio & video latencies differ.

    Both pipelines preserve original capture timestamps (`pts_us`), compensating for
    lookahead and chunking. When both tracks are actively streaming, the faster track
    (typically voice cloning) is held by the smoothed latency delta so audio and video
    packets emerge over the WebSocket in sync while still preserving exact `pts_us`.
    When only one modality is active or the peer track is paused/stale, items emit
    with zero added sync delay.
    """

    def __init__(
        self,
        *,
        emit_fn: Callable[[SyncedOutputItem], Awaitable[None]],
        enabled: bool = True,
        max_hold_s: float = 1.0,
        safety_margin_ms: float = 15.0,
        stale_track_s: float = 2.0,
        max_queued_video: int = 120,
        max_queued_audio: int = 64,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._emit_fn = emit_fn
        self._enabled = enabled
        self._max_hold_s = max_hold_s
        self._safety_margin_s = safety_margin_ms / 1000.0
        self._stale_track_s = stale_track_s
        self._max_queued = {Track.VIDEO: max_queued_video, Track.AUDIO: max_queued_audio}
        self._clock = clock or time.monotonic

        self._voice_active = False
        self._video_active = False

        self._clock_offset_s: float | None = None
        self._last_ingress_s: dict[Track, float] = {}
        self._track_latency_s: dict[Track, float] = {Track.VIDEO: 0.0, Track.AUDIO: 0.0}
        self._has_latency: dict[Track, bool] = {Track.VIDEO: False, Track.AUDIO: False}
        self._last_hold_s: dict[Track, float] = {Track.VIDEO: 0.0, Track.AUDIO: 0.0}

        self._heap: list[tuple[float, int, int, SyncedOutputItem]] = []
        self._order_counter = 0
        self._wakeup = asyncio.Event()
        self._pacer_task: asyncio.Task[None] | None = None
        self._closed = False

    def configure_tracks(self, *, voice_active: bool, video_active: bool) -> None:
        """Set which tracks are currently enabled in the active stream session."""
        self._voice_active = voice_active
        self._video_active = video_active

    def start(self) -> None:
        """Start background pacer task if not already running."""
        if self._closed:
            self._closed = False
        if self._pacer_task is None or self._pacer_task.done():
            self._pacer_task = asyncio.create_task(self._pacer_loop(), name="av-sync-pacer")

    def note_ingress(self, track: Track, pts_us: int, now_s: float | None = None) -> None:
        """Record capture PTS and arrival wall-clock time for clock-offset tracking."""
        now = self._clock() if now_s is None else now_s
        self._last_ingress_s[track] = now
        sample_offset = now - (pts_us / 1_000_000.0)
        if self._clock_offset_s is None:
            self._clock_offset_s = sample_offset
        elif sample_offset < self._clock_offset_s:
            # Faster packet sets lower bound (minimal network jitter); clamp sudden steps.
            self._clock_offset_s = 0.5 * self._clock_offset_s + 0.5 * sample_offset
        else:
            # Slow upward drift compensation for clock skew.
            self._clock_offset_s = 0.99 * self._clock_offset_s + 0.01 * sample_offset

    async def submit_output(self, item: SyncedOutputItem) -> None:
        """Schedule a processed media frame for paced emission."""
        if self._closed:
            return
        now = item.completed_at_s
        if self._clock_offset_s is None:
            self._clock_offset_s = now - (item.pts_us / 1_000_000.0)

        measured_lat_s = max(0.0, (now - self._clock_offset_s) - (item.pts_us / 1_000_000.0))
        if not self._has_latency[item.track]:
            self._track_latency_s[item.track] = measured_lat_s
            self._has_latency[item.track] = True
        else:
            prev = self._track_latency_s[item.track]
            alpha = 0.4 if measured_lat_s > prev else 0.1
            self._track_latency_s[item.track] = (1.0 - alpha) * prev + alpha * measured_lat_s

        dual_active = self._enabled and self._voice_active and self._video_active
        peer = Track.AUDIO if item.track == Track.VIDEO else Track.VIDEO
        peer_last = self._last_ingress_s.get(peer)
        peer_fresh = peer_last is not None and (now - peer_last) <= self._stale_track_s

        if not dual_active or not peer_fresh:
            self._last_hold_s[item.track] = 0.0
            if not self._heap:
                await self._emit_fn(item)
                return
            release_at_s = now
        else:
            target_s = min(
                self._max_hold_s,
                max(self._track_latency_s[Track.VIDEO], self._track_latency_s[Track.AUDIO])
                + self._safety_margin_s,
            )
            desired_release_s = self._clock_offset_s + (item.pts_us / 1_000_000.0) + target_s
            release_at_s = max(now, min(now + self._max_hold_s, desired_release_s))
            self._last_hold_s[item.track] = max(0.0, release_at_s - now)

        self._order_counter += 1
        heapq.heappush(self._heap, (release_at_s, item.pts_us, self._order_counter, item))
        self._enforce_queue_bounds(item.track)
        if self._pacer_task is None or self._pacer_task.done():
            self.start()
        self._wakeup.set()

    def _enforce_queue_bounds(self, track: Track) -> None:
        limit = self._max_queued[track]
        count = sum(1 for _, _, _, queued in self._heap if queued.track == track)
        if count <= limit:
            return
        # Drop oldest items of the overflowing track.
        to_drop = count - limit
        kept: list[tuple[float, int, int, SyncedOutputItem]] = []
        for entry in sorted(self._heap):
            if to_drop > 0 and entry[3].track == track:
                to_drop -= 1
                continue
            kept.append(entry)
        heapq.heapify(kept)
        self._heap = kept

    async def _pacer_loop(self) -> None:
        try:
            while not self._closed:
                while self._heap:
                    release_at_s, _, _, _ = self._heap[0]
                    now = self._clock()
                    delay = release_at_s - now
                    if delay <= 0.001:
                        _, _, _, item = heapq.heappop(self._heap)
                        await self._emit_fn(item)
                        continue
                    self._wakeup.clear()
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(self._wakeup.wait(), timeout=delay)
                    break
                if not self._heap:
                    self._wakeup.clear()
                    await self._wakeup.wait()
        except asyncio.CancelledError:
            return

    def get_telemetry(self) -> SyncTelemetry:
        """Return current smoothed latency and hold offset telemetry."""
        now = self._clock()
        v_fresh = (
            self._video_active
            and (v_ts := self._last_ingress_s.get(Track.VIDEO)) is not None
            and (now - v_ts) <= self._stale_track_s
        )
        a_fresh = (
            self._voice_active
            and (a_ts := self._last_ingress_s.get(Track.AUDIO)) is not None
            and (now - a_ts) <= self._stale_track_s
        )
        sync_active = self._enabled and v_fresh and a_fresh
        v_ms = self._track_latency_s[Track.VIDEO] * 1000.0
        a_ms = self._track_latency_s[Track.AUDIO] * 1000.0
        target_ms = (
            min(
                self._max_hold_s * 1000.0,
                max(v_ms, a_ms) + self._safety_margin_s * 1000.0,
            )
            if sync_active
            else 0.0
        )
        return SyncTelemetry(
            sync_active=sync_active,
            video_latency_ms=round(v_ms, 2),
            audio_latency_ms=round(a_ms, 2),
            target_latency_ms=round(target_ms, 2),
            offset_ms=round(v_ms - a_ms, 2),
            audio_hold_ms=round(self._last_hold_s[Track.AUDIO] * 1000.0, 2),
            video_hold_ms=round(self._last_hold_s[Track.VIDEO] * 1000.0, 2),
        )

    def reset(self) -> None:
        """Clear clock estimation and pending queued frames."""
        self._clock_offset_s = None
        self._last_ingress_s.clear()
        self._track_latency_s = {Track.VIDEO: 0.0, Track.AUDIO: 0.0}
        self._has_latency = {Track.VIDEO: False, Track.AUDIO: False}
        self._last_hold_s = {Track.VIDEO: 0.0, Track.AUDIO: 0.0}
        self._heap.clear()
        self._wakeup.set()

    def mark_track_paused(self, track: Track) -> None:
        """Mark a track temporarily gated/paused so the peer track emits without sync hold."""
        if track in self._last_ingress_s:
            del self._last_ingress_s[track]
            self._last_hold_s[track] = 0.0
            self._wakeup.set()

    async def close(self) -> None:
        """Stop the pacer task and drop buffered items."""
        self._closed = True
        self._heap.clear()
        self._wakeup.set()
        if self._pacer_task is not None:
            self._pacer_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._pacer_task
            self._pacer_task = None
