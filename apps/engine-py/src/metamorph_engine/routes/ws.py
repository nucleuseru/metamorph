"""Multiplexed WebSocket endpoint (`/ws/session`) for real-time voice + video."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from metamorph_engine.assets import AssetError
from metamorph_engine.auth import AuthError, JWTAuthenticator, JWTClaims
from metamorph_engine.lifecycle import (
    InstanceLifecycleManager,
    LifecycleConflictError,
    LifecycleState,
)
from metamorph_engine.protocol import (
    ProtocolError,
    SessionConfigPatch,
    unpack_frame,
)
from metamorph_engine.session import (
    ActiveStreamSession,
    EngineSessionManager,
    ModalityForbiddenError,
)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/session")
async def ws_session(websocket: WebSocket) -> None:
    """Multiplexed binary + JSON WebSocket endpoint for a single dedicated user."""
    settings = websocket.app.state.settings
    authenticator: JWTAuthenticator = websocket.app.state.authenticator
    lifecycle: InstanceLifecycleManager = websocket.app.state.lifecycle
    manager: EngineSessionManager = websocket.app.state.session_manager

    await websocket.accept()

    send_lock = asyncio.Lock()
    superseded_event = asyncio.Event()

    async def _send_json(payload: dict[str, Any]) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    async def _send_bytes(data: bytes) -> None:
        async with send_lock:
            await websocket.send_bytes(data)

    async def _authenticate() -> JWTClaims | None:
        header_token = JWTAuthenticator.extract_bearer(websocket.headers.get("authorization"))
        if header_token is not None:
            try:
                return authenticator.verify_token(header_token)
            except AuthError as exc:
                await _send_json({"type": "error", "code": "auth_failed", "message": exc.detail})
                await websocket.close(code=exc.ws_code, reason=exc.detail)
                return None

        deadline = time.monotonic() + settings.ws_auth_timeout_s
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                await _send_json(
                    {
                        "type": "error",
                        "code": "auth_timeout",
                        "message": "Authentication timed out.",
                    }
                )
                await websocket.close(code=4001, reason="Authentication timed out")
                return None
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=remaining)
            except TimeoutError:
                await _send_json(
                    {
                        "type": "error",
                        "code": "auth_timeout",
                        "message": "Authentication timed out.",
                    }
                )
                await websocket.close(code=4001, reason="Authentication timed out")
                return None

            if message.get("type") == "websocket.disconnect":
                return None
            raw_text = message.get("text")
            if raw_text is None:
                await _send_json(
                    {
                        "type": "error",
                        "code": "auth_required",
                        "message": "Send JSON auth before binary frames.",
                    }
                )
                await websocket.close(code=4001, reason="Auth message required")
                return None
            try:
                payload = json.loads(raw_text)
            except json.JSONDecodeError:
                await _send_json({"type": "error", "code": "bad_json", "message": "Invalid JSON."})
                await websocket.close(code=4001, reason="Invalid auth JSON")
                return None

            if not isinstance(payload, dict) or payload.get("type") != "auth":
                await _send_json(
                    {
                        "type": "error",
                        "code": "auth_required",
                        "message": "First message must be type='auth'.",
                    }
                )
                await websocket.close(code=4001, reason="First message must be auth")
                return None

            token = str(payload.get("token") or "")
            try:
                return authenticator.verify_token(token)
            except AuthError as exc:
                await _send_json({"type": "error", "code": "auth_failed", "message": exc.detail})
                await websocket.close(code=exc.ws_code, reason=exc.detail)
                return None

    claims = await _authenticate()
    if claims is None:
        return

    if lifecycle.state == LifecycleState.BOOTING:
        await _send_json(
            {
                "type": "error",
                "code": "warming",
                "message": "Instance is still warming up.",
            }
        )
        await websocket.close(code=1013, reason="Instance warming up")
        return

    async def _supersede(reason: str) -> None:
        superseded_event.set()
        with contextlib.suppress(Exception):
            await _send_json({"type": "session_superseded", "message": reason})
        with contextlib.suppress(Exception):
            await websocket.close(code=4009, reason=reason)

    try:
        lease_id = await lifecycle.register_connection(claims.sub, _supersede)
    except LifecycleConflictError as exc:
        await _send_json({"type": "error", "code": "shutting_down", "message": str(exc)})
        await websocket.close(code=1013, reason=str(exc))
        return

    active_stream: ActiveStreamSession | None = None
    try:
        await _send_json(
            {
                "type": "auth_ok",
                "user_id": claims.sub,
                "instance_id": settings.instance_id,
                "authorized_modalities": list(claims.modalities),
                "enabled_modalities": list(settings.enabled_modalities),
                "assets": manager.get_bootstrap_status().model_dump(),
            }
        )

        while not superseded_event.is_set():
            if (
                settings.enforce_token_expiry
                and claims.exp
                and time.time() > claims.exp + settings.jwt_leeway_s
            ):
                await _send_json(
                    {
                        "type": "error",
                        "code": "token_expired",
                        "message": "JWT expired; send auth_refresh or reconnect.",
                    }
                )
                await websocket.close(code=4001, reason="JWT expired")
                break

            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=2.0)
            except TimeoutError:
                continue

            if message.get("type") == "websocket.disconnect" or superseded_event.is_set():
                break

            raw_bytes = message.get("bytes")
            if raw_bytes is not None:
                if active_stream is None:
                    await _send_json(
                        {
                            "type": "error",
                            "code": "not_started",
                            "message": "Send control message type='start' before binary frames.",
                        }
                    )
                    continue
                try:
                    header, payload_mv = unpack_frame(raw_bytes)
                except ProtocolError as exc:
                    await _send_json(
                        {"type": "error", "code": "protocol_error", "message": str(exc)}
                    )
                    continue

                await active_stream.submit_binary_frame(
                    track=header.track,
                    codec=header.codec,
                    flags=header.flags,
                    seq=header.seq,
                    pts_us=header.pts_us,
                    payload=payload_mv,
                )
                continue

            raw_text = message.get("text")
            if raw_text is None:
                continue
            try:
                payload = json.loads(raw_text)
            except json.JSONDecodeError:
                await _send_json({"type": "error", "code": "bad_json", "message": "Invalid JSON."})
                continue
            if not isinstance(payload, dict):
                await _send_json(
                    {"type": "error", "code": "bad_json", "message": "Expected JSON object."}
                )
                continue

            msg_type = payload.get("type")

            if msg_type == "auth_refresh":
                try:
                    claims = authenticator.verify_token(str(payload.get("token") or ""))
                    await _send_json(
                        {
                            "type": "auth_ok",
                            "user_id": claims.sub,
                            "instance_id": settings.instance_id,
                            "authorized_modalities": list(claims.modalities),
                            "enabled_modalities": list(settings.enabled_modalities),
                            "assets": manager.get_bootstrap_status().model_dump(),
                        }
                    )
                except AuthError as exc:
                    await _send_json(
                        {"type": "error", "code": "auth_failed", "message": exc.detail}
                    )
                    await websocket.close(code=exc.ws_code, reason=exc.detail)
                    break

            elif msg_type == "ping":
                await _send_json(
                    {
                        "type": "pong",
                        "t": payload.get("t"),
                        "ts": time.time() * 1000.0,
                    }
                )

            elif msg_type == "start":
                patch_data = {k: v for k, v in payload.items() if k not in ("type", "session_id")}
                try:
                    patch = SessionConfigPatch.model_validate(patch_data)
                    raw_sid = payload.get("session_id")
                    active_stream = await manager.start_stream(
                        patch=patch,
                        authorized_modalities=claims.modalities,
                        send_bytes_cb=_send_bytes,
                        send_json_cb=_send_json,
                        session_id=str(raw_sid) if raw_sid else None,
                    )
                    v_cfg = active_stream.video_config
                    a_cfg = active_stream.voice_config
                    await _send_json(
                        {
                            "type": "started",
                            "session_id": active_stream.session_id,
                            "voice_active": active_stream.voice_active,
                            "video_active": active_stream.video_active,
                            "video_config": (
                                {
                                    "input_codec": v_cfg.input_codec,
                                    "output_codec": v_cfg.output_codec,
                                    "width": v_cfg.width,
                                    "height": v_cfg.height,
                                    "fps": v_cfg.fps,
                                    "detection_mode": v_cfg.detection_mode,
                                }
                                if v_cfg is not None
                                else None
                            ),
                            "audio_config": (
                                {
                                    "input_codec": a_cfg.input_codec.name.lower(),
                                    "output_codec": a_cfg.output_codec.name.lower(),
                                    "input_sample_rate": a_cfg.input_sample_rate,
                                    "output_sample_rate": a_cfg.output_sample_rate,
                                    "block_time_s": a_cfg.block_time_s,
                                }
                                if a_cfg is not None
                                else None
                            ),
                            "assets": manager.get_bootstrap_status().model_dump(),
                        }
                    )
                except ModalityForbiddenError as exc:
                    await _send_json({"type": "error", "code": "forbidden", "message": str(exc)})
                except (ValidationError, AssetError, ValueError) as exc:
                    await _send_json(
                        {"type": "error", "code": "invalid_config", "message": str(exc)}
                    )

            elif msg_type == "update_config":
                patch_data = {k: v for k, v in payload.items() if k != "type"}
                try:
                    patch = SessionConfigPatch.model_validate(patch_data)
                    res = await manager.apply_config_patch(
                        patch,
                        authorized_modalities=claims.modalities,
                    )
                    await _send_json({"type": "config_updated", **res.model_dump()})
                except ModalityForbiddenError as exc:
                    await _send_json({"type": "error", "code": "forbidden", "message": str(exc)})
                except (ValidationError, AssetError, ValueError) as exc:
                    await _send_json(
                        {"type": "error", "code": "invalid_config", "message": str(exc)}
                    )

            elif msg_type == "stop":
                if active_stream is not None:
                    await manager.stop_stream(active_stream)
                    active_stream = None
                await _send_json({"type": "stopped"})

            else:
                await _send_json(
                    {
                        "type": "error",
                        "code": "unknown_message",
                        "message": f"Unknown type: {msg_type!r}",
                    }
                )

    except WebSocketDisconnect:
        pass
    finally:
        if active_stream is not None:
            await manager.stop_stream(active_stream)
        await lifecycle.release_connection(lease_id)
