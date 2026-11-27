"""System liveness and readiness probe endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from metamorph_engine.lifecycle import InstanceLifecycleManager, LifecycleState
from metamorph_engine.protocol import HealthResponse, ReadyResponse

router = APIRouter(tags=["system"])


@router.get("/health")
async def health(request: Request) -> HealthResponse:
    """Liveness probe for orchestrators and load balancers."""
    settings = request.app.state.settings
    return HealthResponse(
        status="ok",
        instance_id=settings.instance_id,
        backend=settings.backend,
        enabled_modalities=list(settings.enabled_modalities),
    )


@router.get("/ready")
async def ready(request: Request, response: Response) -> ReadyResponse:
    """Readiness probe; returns 503 during warmup or shutdown."""
    settings = request.app.state.settings
    lifecycle: InstanceLifecycleManager = request.app.state.lifecycle
    if lifecycle.state == LifecycleState.BOOTING:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        ready_state = "warming"
    elif lifecycle.state == LifecycleState.SHUTTING_DOWN:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        ready_state = "shutting_down"
    else:
        ready_state = "ready"

    return ReadyResponse(
        status=ready_state,
        lifecycle_state=str(lifecycle.state),
        instance_id=settings.instance_id,
        enabled_modalities=list(settings.enabled_modalities),
    )
