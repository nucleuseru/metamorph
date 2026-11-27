"""Single-user instance lifecycle manager, timers, takeover, and signed webhooks."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import Any

import httpx

from metamorph_engine.config import EngineSettings

logger = logging.getLogger("metamorph_engine.lifecycle")


class LifecycleState(StrEnum):
    """Dedicated instance lifecycle states."""

    BOOTING = "booting"
    READY_IDLE = "ready_idle"
    ACTIVE = "active"
    DISCONNECT_GRACE = "disconnect_grace"
    SHUTTING_DOWN = "shutting_down"


class LifecycleConflictError(RuntimeError):
    """Raised when a connection arrives while the instance is shutting down."""


class InstanceLifecycleManager:
    """Manages idle/disconnect shutdown timers, single-user takeover, and webhooks."""

    def __init__(
        self,
        settings: EngineSettings,
        *,
        shutdown_callback: Callable[[], None] | None = None,
        webhook_transport: httpx.AsyncBaseTransport | None = None,
        on_teardown: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._settings = settings
        self._shutdown_callback = shutdown_callback
        self._webhook_transport = webhook_transport
        self._on_teardown = on_teardown

        self._state = LifecycleState.BOOTING
        self._lock = asyncio.Lock()

        self._active_lease_id: str | None = None
        self._active_user_id: str | None = settings.user_id
        self._supersede_cb: Callable[[str], Awaitable[None]] | None = None

        self._idle_timer_task: asyncio.Task[None] | None = None
        self._idle_deadline_mono: float | None = None

        self._disconnect_timer_task: asyncio.Task[None] | None = None
        self._disconnect_deadline_mono: float | None = None

        self._shutdown_task: asyncio.Task[None] | None = None
        self._shutdown_reason: str | None = None
        self._background_tasks: set[asyncio.Task[None]] = set()

    @property
    def state(self) -> LifecycleState:
        """Return current lifecycle state."""
        return self._state

    @property
    def active_user_id(self) -> str | None:
        """Return bound user id if authenticated."""
        return self._active_user_id

    @property
    def connected(self) -> bool:
        """Return True while a client WebSocket holds the active lease."""
        return self._active_lease_id is not None and self._state == LifecycleState.ACTIVE

    @property
    def is_ready(self) -> bool:
        """Return True when warmup completed and instance is not shutting down."""
        return self._state not in (LifecycleState.BOOTING, LifecycleState.SHUTTING_DOWN)

    @property
    def shutdown_reason(self) -> str | None:
        """Return recorded shutdown reason once shutdown has begun."""
        return self._shutdown_reason

    def disconnect_countdown_remaining_s(self) -> float | None:
        """Return remaining seconds before disconnect-grace shutdown triggers."""
        if self._disconnect_deadline_mono is None or self._state != LifecycleState.DISCONNECT_GRACE:
            return None
        return round(max(0.0, self._disconnect_deadline_mono - time.monotonic()), 2)

    def idle_countdown_remaining_s(self) -> float | None:
        """Return remaining seconds before startup-idle shutdown triggers."""
        if self._idle_deadline_mono is None or self._state != LifecycleState.READY_IDLE:
            return None
        return round(max(0.0, self._idle_deadline_mono - time.monotonic()), 2)

    async def mark_ready(self) -> None:
        """Transition BOOTING -> READY_IDLE, start idle timeout, emit `ready` webhook."""
        async with self._lock:
            if self._state != LifecycleState.BOOTING:
                return
            self._state = LifecycleState.READY_IDLE
            self._start_idle_timer_locked()
        await self._emit_webhook(
            "ready", {"enabled_modalities": list(self._settings.enabled_modalities)}
        )

    async def mark_startup_failed(self, error: str) -> None:
        """Record fatal startup failure and trigger graceful shutdown."""
        await self.request_shutdown(f"startup_failed: {error}")

    async def register_connection(
        self,
        user_id: str,
        supersede_cb: Callable[[str], Awaitable[None]],
    ) -> str:
        """Acquire exclusive active lease for `user_id`, superseding any stale socket."""
        prev_supersede: Callable[[str], Awaitable[None]] | None = None
        emit_connected = False
        async with self._lock:
            if self._state == LifecycleState.SHUTTING_DOWN:
                raise LifecycleConflictError("Instance is shutting down.")

            self._cancel_idle_timer_locked()
            self._cancel_disconnect_timer_locked()

            if self._active_lease_id is not None and self._supersede_cb is not None:
                prev_supersede = self._supersede_cb
            else:
                emit_connected = True

            lease_id = uuid.uuid4().hex
            self._active_lease_id = lease_id
            self._active_user_id = user_id
            self._supersede_cb = supersede_cb
            self._state = LifecycleState.ACTIVE

        if prev_supersede is not None:
            try:
                await prev_supersede("superseded by new connection")
            except Exception:
                logger.exception("Error while closing superseded WebSocket connection.")

        if emit_connected:
            await self._emit_webhook("connected", {"user_id": user_id})

        return lease_id

    async def release_connection(
        self, lease_id: str, *, reason: str = "client_disconnected"
    ) -> None:
        """Release active lease if it still matches `lease_id`; start disconnect grace timer."""
        emit_disconnected = False
        async with self._lock:
            if lease_id != self._active_lease_id:
                # Superseded connection cleanup; do not interrupt the replacement socket.
                return
            self._active_lease_id = None
            self._supersede_cb = None
            if self._state == LifecycleState.SHUTTING_DOWN:
                return
            self._state = LifecycleState.DISCONNECT_GRACE
            self._start_disconnect_timer_locked()
            emit_disconnected = True

        if emit_disconnected:
            await self._emit_webhook(
                "disconnected",
                {
                    "user_id": self._active_user_id,
                    "reason": reason,
                    "disconnect_timeout_s": self._settings.disconnect_timeout_s,
                },
            )

    async def request_shutdown(self, reason: str) -> None:
        """Idempotently transition to SHUTTING_DOWN and run graceful teardown."""
        async with self._lock:
            if self._state == LifecycleState.SHUTTING_DOWN:
                task = self._shutdown_task
            else:
                self._state = LifecycleState.SHUTTING_DOWN
                self._shutdown_reason = reason
                self._cancel_idle_timer_locked()
                self._cancel_disconnect_timer_locked()
                self._shutdown_task = asyncio.create_task(
                    self._execute_shutdown(reason),
                    name="engine-lifecycle-shutdown",
                )
                task = self._shutdown_task
        if task is not None:
            await asyncio.shield(task)

    def schedule_shutdown(self, reason: str) -> None:
        """Fire-and-forget shutdown trigger safe to call from HTTP handlers or timers."""
        if self._state == LifecycleState.SHUTTING_DOWN and self._shutdown_task is not None:
            return
        task = asyncio.create_task(self.request_shutdown(reason), name=f"shutdown-trigger-{reason}")
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    async def cancel_timers(self) -> None:
        """Cancel timers without emitting webhooks (used during uvicorn lifespan exit)."""
        async with self._lock:
            self._cancel_idle_timer_locked()
            self._cancel_disconnect_timer_locked()

    def _start_idle_timer_locked(self) -> None:
        self._cancel_idle_timer_locked()
        timeout = self._settings.startup_idle_timeout_s
        self._idle_deadline_mono = time.monotonic() + timeout
        self._idle_timer_task = asyncio.create_task(
            self._timer_worker(timeout, "startup_idle_timeout"),
            name="startup-idle-timer",
        )

    def _cancel_idle_timer_locked(self) -> None:
        self._idle_deadline_mono = None
        if self._idle_timer_task is not None and not self._idle_timer_task.done():
            self._idle_timer_task.cancel()
        self._idle_timer_task = None

    def _start_disconnect_timer_locked(self) -> None:
        self._cancel_disconnect_timer_locked()
        timeout = self._settings.disconnect_timeout_s
        self._disconnect_deadline_mono = time.monotonic() + timeout
        self._disconnect_timer_task = asyncio.create_task(
            self._timer_worker(timeout, "disconnect_grace_timeout"),
            name="disconnect-grace-timer",
        )

    def _cancel_disconnect_timer_locked(self) -> None:
        self._disconnect_deadline_mono = None
        if self._disconnect_timer_task is not None and not self._disconnect_timer_task.done():
            self._disconnect_timer_task.cancel()
        self._disconnect_timer_task = None

    async def _timer_worker(self, delay_s: float, reason: str) -> None:
        try:
            await asyncio.sleep(delay_s)
        except asyncio.CancelledError:
            return
        logger.info("Lifecycle timer expired (%s after %.1fs); shutting down.", reason, delay_s)
        await self.request_shutdown(reason)

    async def _execute_shutdown(self, reason: str) -> None:
        if self._supersede_cb is not None:
            try:
                await self._supersede_cb(f"instance shutting down: {reason}")
            except Exception:
                logger.exception("Failed closing active socket during shutdown.")

        if self._on_teardown is not None:
            try:
                await asyncio.wait_for(
                    self._on_teardown(),
                    timeout=self._settings.shutdown_grace_s,
                )
            except Exception:
                logger.exception("Error during lifecycle teardown hook.")

        await self._emit_webhook(
            "shutting_down",
            {
                "user_id": self._active_user_id,
                "reason": reason,
            },
            retries=3,
        )

        if self._shutdown_callback is not None:
            try:
                self._shutdown_callback()
            except Exception:
                logger.exception("Shutdown callback raised an exception.")

    async def _emit_webhook(
        self,
        event: str,
        data: dict[str, Any],
        *,
        retries: int = 1,
    ) -> None:
        url = self._settings.lifecycle_webhook_url
        if not url:
            return

        payload = {
            "event": event,
            "instance_id": self._settings.instance_id,
            "timestamp": time.time(),
            **data,
        }
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        secret = self._settings.lifecycle_webhook_secret
        if secret:
            digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
            headers["X-Metamorph-Signature"] = f"sha256={digest}"

        client_kwargs: dict[str, Any] = {"timeout": self._settings.lifecycle_webhook_timeout_s}
        if self._webhook_transport is not None:
            client_kwargs["transport"] = self._webhook_transport

        async with httpx.AsyncClient(**client_kwargs) as client:
            for attempt in range(retries):
                try:
                    resp = await client.post(url, content=body, headers=headers)
                    resp.raise_for_status()
                    return
                except Exception as exc:
                    if attempt + 1 >= retries:
                        logger.warning("Lifecycle webhook %s failed: %s", event, exc)
                        return
                    await asyncio.sleep(min(0.5 * (attempt + 1), 2.0))
