"""Tests for dedicated instance lifecycle, timeouts, single-user takeover, and webhooks."""

from __future__ import annotations

import asyncio
import logging
import threading
import time

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from metamorph_engine.lifecycle import InstanceLifecycleManager, LifecycleState
from metamorph_engine.main import configure_engine_logging, create_app
from starlette.websockets import WebSocketDisconnect
from tests.conftest import (
    WebhookRecorder,
    build_test_settings,
    mint_jwt,
)


def test_readiness_and_startup_idle_shutdown_fires_signed_webhook() -> None:
    recorder = WebhookRecorder(secret="webhook-secret")
    shutdown_called = False

    def _on_shutdown() -> None:
        nonlocal shutdown_called
        shutdown_called = True

    settings = build_test_settings(
        startup_idle_timeout_s=0.25,
        disconnect_timeout_s=0.25,
        lifecycle_webhook_url="https://api.example.com/webhooks/engine",
        lifecycle_webhook_secret="webhook-secret",
    )
    app = create_app(
        settings,
        shutdown_callback=_on_shutdown,
        webhook_transport=recorder,
    )

    # Before lifespan starts, /ready returns 503 warming
    client_no_lifespan = TestClient(app)
    assert client_no_lifespan.get("/health").status_code == 200
    assert client_no_lifespan.get("/ready").status_code == 503

    with TestClient(app) as client:
        ready = client.get("/ready")
        assert ready.status_code == 200
        assert ready.json()["status"] == "ready"
        assert ready.json()["lifecycle_state"] == LifecycleState.READY_IDLE

        # Wait for startup_idle_timeout_s (0.25s) to trigger shutdown
        deadline = time.monotonic() + 2.0
        while not shutdown_called and time.monotonic() < deadline:
            time.sleep(0.05)

        assert shutdown_called is True
        assert client.get("/ready").status_code == 503

    event_names = [e.payload["event"] for e in recorder.events]
    assert event_names == ["ready", "shutting_down"]
    assert recorder.events[1].payload["reason"] == "startup_idle_timeout"


def test_disconnect_grace_timeout_and_reconnect_cancellation(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    recorder = WebhookRecorder(secret="hook-secret")
    shutdown_called = False

    def _on_shutdown() -> None:
        nonlocal shutdown_called
        shutdown_called = True

    settings = build_test_settings(
        startup_idle_timeout_s=5.0,
        disconnect_timeout_s=0.35,
        lifecycle_webhook_url="https://api.example.com/hooks",
        lifecycle_webhook_secret="hook-secret",
    )
    app = create_app(
        settings,
        shutdown_callback=_on_shutdown,
        webhook_transport=recorder,
    )
    token = mint_jwt(jwks_signer, modalities=["voice", "video"])

    with TestClient(app) as client:
        # Connect and disconnect, then reconnect BEFORE 0.35s grace expires
        with client.websocket_connect("/ws/session") as ws1:
            ws1.send_json({"type": "auth", "token": token})
            assert ws1.receive_json()["type"] == "auth_ok"

        time.sleep(0.10)
        assert shutdown_called is False

        with client.websocket_connect("/ws/session") as ws2:
            ws2.send_json({"type": "auth", "token": token})
            assert ws2.receive_json()["type"] == "auth_ok"
            time.sleep(0.35)
            # While connected, shutdown must NOT happen
            assert shutdown_called is False

        # Now let disconnect grace expire after ws2 closes
        deadline = time.monotonic() + 2.0
        while not shutdown_called and time.monotonic() < deadline:
            time.sleep(0.05)

        assert shutdown_called is True

    events = [e.payload["event"] for e in recorder.events]
    assert "ready" in events
    assert "connected" in events
    assert "disconnected" in events
    assert events[-1] == "shutting_down"


def test_single_user_takeover_closes_stale_socket_without_disconnect_countdown(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    recorder = WebhookRecorder()
    shutdown_called = False

    def _on_shutdown() -> None:
        nonlocal shutdown_called
        shutdown_called = True

    settings = build_test_settings(
        startup_idle_timeout_s=5.0,
        disconnect_timeout_s=0.25,
        lifecycle_webhook_url="https://api.example.com/hooks",
    )
    app = create_app(
        settings,
        shutdown_callback=_on_shutdown,
        webhook_transport=recorder,
    )
    token = mint_jwt(jwks_signer, modalities=["voice", "video"])

    with TestClient(app) as client, client.websocket_connect("/ws/session") as ws1:
        ws1.send_json({"type": "auth", "token": token})
        assert ws1.receive_json()["type"] == "auth_ok"

        with client.websocket_connect("/ws/session") as ws2:
            ws2.send_json({"type": "auth", "token": token})
            assert ws2.receive_json()["type"] == "auth_ok"

            # ws1 must receive takeover notice and close code 4009
            notice = ws1.receive_json()
            assert notice["type"] == "session_superseded"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws1.receive_text()
            assert exc_info.value.code == 4009

            # Wait longer than disconnect_timeout_s while ws2 is open
            time.sleep(0.35)
            assert shutdown_called is False
            status_resp = client.get(
                "/session/status",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert status_resp.status_code == 200
            assert status_resp.json()["lifecycle_state"] == LifecycleState.ACTIVE
            assert status_resp.json()["connected"] is True

    # Ensure no spurious 'disconnected' happened during takeover
    event_names = [e.payload["event"] for e in recorder.events]
    assert event_names.count("connected") == 1
    assert event_names.count("disconnected") == 1


@pytest.mark.asyncio
async def test_explicit_http_shutdown_triggers_teardown(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    shutdown_event = asyncio.Event()

    def _on_shutdown() -> None:
        shutdown_event.set()

    settings = build_test_settings()
    app = create_app(settings, shutdown_callback=_on_shutdown)
    token = mint_jwt(jwks_signer, modalities=["voice", "video"])

    with TestClient(app) as client:
        resp = client.post(
            "/session/shutdown",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "shutting_down"
        time.sleep(0.1)
        assert app.state.lifecycle.state == LifecycleState.SHUTTING_DOWN


def test_async_startup_serves_health_and_503_ready_while_warming(
    monkeypatch: pytest.MonkeyPatch,
    jwks_signer: Ed25519PrivateKey,
) -> None:
    from metamorph_engine import session as session_mod

    token = mint_jwt(jwks_signer, modalities=["voice", "video"])

    warmup_started = threading.Event()
    allow_warmup = threading.Event()

    async def _gated_warmup(self) -> None:
        warmup_started.set()
        await asyncio.to_thread(allow_warmup.wait, 5.0)

    monkeypatch.setattr(session_mod.EngineSessionManager, "load_and_warmup", _gated_warmup)

    settings = build_test_settings(async_startup=True)
    app = create_app(settings)

    with TestClient(app) as client:
        assert warmup_started.wait(timeout=2.0)

        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        ready = client.get("/ready")
        assert ready.status_code == 503
        assert ready.json()["status"] == "warming"
        assert ready.json()["lifecycle_state"] == LifecycleState.BOOTING

        cfg_resp = client.post(
            "/session/config",
            headers={"Authorization": f"Bearer {token}"},
            json={"prompt": "Warming check"},
        )
        assert cfg_resp.status_code == 503

        with client.websocket_connect("/ws/session") as ws:
            ws.send_json({"type": "auth", "token": token})
            err = ws.receive_json()
            assert err["type"] == "error"
            assert err["code"] == "warming"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_text()
            assert exc_info.value.code == 1013

        allow_warmup.set()
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            ready_after = client.get("/ready")
            if ready_after.status_code == 200:
                break
            time.sleep(0.02)
        assert ready_after.status_code == 200
        assert ready_after.json()["status"] == "ready"
        assert ready_after.json()["lifecycle_state"] == LifecycleState.READY_IDLE

        with client.websocket_connect("/ws/session") as ws2:
            ws2.send_json({"type": "auth", "token": token})
            assert ws2.receive_json()["type"] == "auth_ok"


def test_async_startup_failure_triggers_shutdown_webhook(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from metamorph_engine import session as session_mod

    recorder = WebhookRecorder(secret="hook-secret")
    shutdown_called = threading.Event()

    async def _failing_warmup(self) -> None:
        raise RuntimeError("missing cuda weights")

    monkeypatch.setattr(session_mod.EngineSessionManager, "load_and_warmup", _failing_warmup)

    settings = build_test_settings(
        async_startup=True,
        lifecycle_webhook_url="https://api.example.com/hooks",
        lifecycle_webhook_secret="hook-secret",
    )
    app = create_app(
        settings,
        shutdown_callback=shutdown_called.set,
        webhook_transport=recorder,
    )

    with TestClient(app):
        assert shutdown_called.wait(timeout=2.0)
        assert app.state.lifecycle.state == LifecycleState.SHUTTING_DOWN

    assert any(
        e.payload["event"] == "shutting_down"
        and "startup_failed: missing cuda weights" in e.payload["reason"]
        for e in recorder.events
    )


@pytest.mark.asyncio
async def test_runpod_proxy_wait_defers_ready_webhook_until_proxy_is_reachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RUNPOD_POD_ID", "podfast123")
    recorder = WebhookRecorder(secret="hook-secret")
    probe_attempts: list[str] = []

    def _proxy_handler(request: httpx.Request) -> httpx.Response:
        probe_attempts.append(str(request.url))
        if len(probe_attempts) < 3:
            return httpx.Response(502, text="Bad Gateway")
        return httpx.Response(200, json={"status": "ok"})

    settings = build_test_settings(
        startup_idle_timeout_s=30.0,
        lifecycle_webhook_url="https://api.example.com/hooks",
        lifecycle_webhook_secret="hook-secret",
    )
    lifecycle = InstanceLifecycleManager(
        settings,
        webhook_transport=recorder,
        proxy_probe_transport=httpx.MockTransport(_proxy_handler),
    )

    orig_wait = lifecycle._wait_for_runpod_proxy_ready

    async def _fast_wait() -> None:
        await orig_wait(max_wait_s=5.0, poll_interval_s=0.02)

    monkeypatch.setattr(lifecycle, "_wait_for_runpod_proxy_ready", _fast_wait)
    await lifecycle.mark_ready()
    await lifecycle.cancel_timers()

    assert len(probe_attempts) == 3
    assert probe_attempts[0] == "https://podfast123-8000.proxy.runpod.net/health"
    assert [e.payload["event"] for e in recorder.events] == ["ready"]


def test_configure_engine_logging_enables_info_logs_on_package_logger() -> None:
    configure_engine_logging("info")
    pkg_logger = logging.getLogger("metamorph_engine")
    assert pkg_logger.level == logging.INFO
    assert len(pkg_logger.handlers) >= 1
    assert pkg_logger.propagate is False
