"""Authenticated HTTP endpoints for session status, assets, config, and shutdown."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile

from metamorph_engine.assets import AssetError
from metamorph_engine.auth import RequireAuthDep, require_http_auth
from metamorph_engine.lifecycle import InstanceLifecycleManager, LifecycleState
from metamorph_engine.protocol import (
    ConfigUpdateResponse,
    SessionConfigPatch,
    SessionStatusResponse,
    ShutdownResponse,
)
from metamorph_engine.session import EngineSessionManager, ModalityForbiddenError

router = APIRouter(
    prefix="/session",
    tags=["session"],
    dependencies=[Depends(require_http_auth)],
)


@router.get("/status")
async def get_session_status(
    request: Request,
    claims: RequireAuthDep,
) -> SessionStatusResponse:
    """Return instance lifecycle state, countdowns, staged assets, and sync telemetry."""
    settings = request.app.state.settings
    lifecycle: InstanceLifecycleManager = request.app.state.lifecycle
    manager: EngineSessionManager = request.app.state.session_manager
    active = manager.active_stream
    return SessionStatusResponse(
        instance_id=settings.instance_id,
        user_id=lifecycle.active_user_id or claims.sub,
        lifecycle_state=str(lifecycle.state),
        enabled_modalities=list(settings.enabled_modalities),
        connected=lifecycle.connected,
        active_session_id=active.session_id if active is not None else None,
        disconnect_countdown_s=lifecycle.disconnect_countdown_remaining_s(),
        idle_countdown_s=lifecycle.idle_countdown_remaining_s(),
        assets=manager.get_bootstrap_status(),
        sync=manager.get_sync_telemetry(),
    )


@router.post("/config")
async def update_session_config(
    request: Request,
    patch: SessionConfigPatch,
    claims: RequireAuthDep,
) -> ConfigUpdateResponse:
    """Update prompt, asset URLs/base64, or pipeline parameters (hot-swapping if active)."""
    if request.app.state.lifecycle.state == LifecycleState.BOOTING:
        raise HTTPException(status_code=503, detail="Instance is still warming up.")
    manager: EngineSessionManager = request.app.state.session_manager
    try:
        return await manager.apply_config_patch(
            patch,
            authorized_modalities=claims.modalities,
        )
    except ModalityForbiddenError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except AssetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/assets")
async def upload_session_assets(
    request: Request,
    claims: RequireAuthDep,
    prompt: Annotated[str | None, Form()] = None,
    clear_ref_image: Annotated[bool, Form()] = False,
    ref_image: Annotated[UploadFile | None, File()] = None,
    ref_audio: Annotated[UploadFile | None, File()] = None,
) -> ConfigUpdateResponse:
    """Upload multipart prompt, RV2V reference image, and/or Seed-VC reference audio."""
    if request.app.state.lifecycle.state == LifecycleState.BOOTING:
        raise HTTPException(status_code=503, detail="Instance is still warming up.")
    manager: EngineSessionManager = request.app.state.session_manager
    ref_image_bytes = await ref_image.read() if ref_image is not None else None
    ref_audio_bytes = await ref_audio.read() if ref_audio is not None else None
    patch = SessionConfigPatch(prompt=prompt, clear_ref_image=clear_ref_image)
    try:
        return await manager.apply_config_patch(
            patch,
            authorized_modalities=claims.modalities,
            ref_image_bytes=ref_image_bytes,
            ref_audio_bytes=ref_audio_bytes,
        )
    except ModalityForbiddenError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except AssetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/shutdown")
async def shutdown_instance(
    request: Request,
    claims: RequireAuthDep,
) -> ShutdownResponse:
    """Explicitly trigger graceful instance teardown and signed webhook emission."""
    lifecycle: InstanceLifecycleManager = request.app.state.lifecycle
    reason = f"api_requested_by:{claims.sub}"
    lifecycle.schedule_shutdown(reason)
    return ShutdownResponse(status="shutting_down", reason=reason)
