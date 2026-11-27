"""FastAPI + uvloop entrypoint for metamorph-engine."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager

import httpx
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from metamorph_engine.assets import AssetLoader
from metamorph_engine.auth import JWTAuthenticator
from metamorph_engine.config import EngineSettings, get_settings
from metamorph_engine.lifecycle import InstanceLifecycleManager
from metamorph_engine.routes import session_router, system_router, ws_router
from metamorph_engine.session import EngineSessionManager

logger = logging.getLogger("metamorph_engine.main")


def create_app(
    settings: EngineSettings | None = None,
    *,
    shutdown_callback: Callable[[], None] | None = None,
    webhook_transport: httpx.AsyncBaseTransport | None = None,
    asset_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """Create and wire a configured FastAPI inference application."""
    cfg = settings or get_settings()
    authenticator = JWTAuthenticator(cfg)
    asset_loader = AssetLoader(cfg, http_transport=asset_transport)
    session_manager = EngineSessionManager(cfg, asset_loader)
    lifecycle = InstanceLifecycleManager(
        cfg,
        shutdown_callback=shutdown_callback,
        webhook_transport=webhook_transport,
        on_teardown=session_manager.shutdown_pipelines,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        """Load enabled pipelines, optionally bootstrap assets, and mark instance ready."""

        async def _boot_sequence() -> None:
            await session_manager.load_and_warmup()
            await session_manager.bootstrap_assets()
            await lifecycle.mark_ready()

        startup_task: asyncio.Task[None] | None = None
        if cfg.use_async_startup:

            async def _run_async_boot() -> None:
                try:
                    await _boot_sequence()
                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    logger.exception("Async startup warmup failed: %s", exc)
                    await lifecycle.mark_startup_failed(str(exc))

            startup_task = asyncio.create_task(_run_async_boot(), name="engine-startup-warmup")
        else:
            await _boot_sequence()

        try:
            yield
        finally:
            if startup_task is not None and not startup_task.done():
                startup_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await startup_task
            await lifecycle.cancel_timers()
            await session_manager.shutdown_pipelines()

    application = FastAPI(
        title="metamorph-engine",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )
    application.state.settings = cfg
    application.state.authenticator = authenticator
    application.state.asset_loader = asset_loader
    application.state.session_manager = session_manager
    application.state.lifecycle = lifecycle

    application.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    application.include_router(system_router)
    application.include_router(session_router)
    application.include_router(ws_router)
    return application


app = create_app()


def run() -> None:
    """Launch uvicorn with uvloop and httptools wired to lifecycle exit."""
    settings = get_settings()
    server_holder: dict[str, uvicorn.Server] = {}

    def _trigger_exit() -> None:
        srv = server_holder.get("server")
        if srv is not None:
            srv.should_exit = True

    application = create_app(settings, shutdown_callback=_trigger_exit)
    config = uvicorn.Config(
        application,
        host=settings.host,
        port=settings.port,
        workers=1,
        loop="uvloop",
        http="httptools",
        ws="websockets",
        ws_max_size=settings.ws_max_size_bytes,
        ws_per_message_deflate=False,
        access_log=settings.access_log,
        log_level=settings.log_level,
    )
    server = uvicorn.Server(config)
    server_holder["server"] = server
    server.run()


if __name__ == "__main__":
    run()
