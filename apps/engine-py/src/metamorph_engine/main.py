"""FastAPI + uvloop entrypoint for metamorph-engine."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Response, WebSocket, WebSocketDisconnect, status

from metamorph_engine.config import get_settings


class EngineState:
    """Tracks model readiness and warm state across the pod lifecycle."""

    ready: bool = False


state = EngineState()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    """Load and warm up inference pipelines before serving traffic."""
    settings = get_settings()
    if settings.warmup_on_startup:
        # TODO: Initialize and warm up seed-vc & JoyAI-Video-Edit pipelines.
        pass
    state.ready = True
    try:
        yield
    finally:
        state.ready = False


app = FastAPI(
    title="metamorph-engine",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe for RunPod and load balancers."""
    return {"status": "ok"}


@app.get("/ready")
async def ready(response: Response) -> dict[str, str]:
    """Readiness probe; returns 503 until models are loaded and warmed up."""
    if not state.ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "warming"}
    return {"status": "ready"}


@app.websocket("/ws/voice")
async def voice_stream(websocket: WebSocket) -> None:
    """Binary WebSocket stream for real-time voice cloning (seed-vc)."""
    await websocket.accept()
    try:
        while True:
            chunk = await websocket.receive_bytes()
            # TODO: Route PCM audio chunk through seed-vc streaming pipeline.
            await websocket.send_bytes(chunk)
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/video")
async def video_stream(websocket: WebSocket) -> None:
    """Binary WebSocket stream for real-time body swap / video editing (JoyAI-Video-Edit)."""
    await websocket.accept()
    try:
        while True:
            frame = await websocket.receive_bytes()
            # TODO: Route video frame through JoyAI-Video-Edit streaming pipeline.
            await websocket.send_bytes(frame)
    except WebSocketDisconnect:
        pass


def run() -> None:
    """Launch uvicorn with uvloop and httptools for minimal overhead."""
    settings = get_settings()
    uvicorn.run(
        "metamorph_engine.main:app",
        host=settings.host,
        port=settings.port,
        workers=settings.workers,
        loop="uvloop",
        http="httptools",
        ws="websockets",
        access_log=settings.access_log,
        log_level=settings.log_level,
    )


if __name__ == "__main__":
    run()
