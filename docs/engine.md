# Inference Engine (`apps/engine-py`)

`metamorph-engine` (`apps/engine-py`) is the low-latency Python GPU inference server deployed to RunPod pods. It hosts:

- **Real-time voice cloning** (backed by `vendor/seed-vc`)
- **Full-body swap & video editing** (backed by `vendor/JoyAI-Video-Edit`)

## Stack

- **Framework & Server**: FastAPI + `uvicorn` with `uvloop`, `httptools`, and `websockets`
- **Configuration**: `pydantic-settings` (`EngineSettings` in `src/metamorph_engine/config.py`)
- **Workspace Dependencies**: `metamorph-shared` (`packages/shared-py`)

## Endpoints

- `GET /health` — Liveness probe returning `{"status": "ok"}`
- `GET /ready` — Readiness probe returning `503` `{"status": "warming"}` until startup warmup completes, then `{"status": "ready"}`
- `WS /ws/voice` — Binary WebSocket stream for real-time voice cloning (`seed-vc`)
- `WS /ws/video` — Binary WebSocket stream for real-time body swap / video editing (`JoyAI-Video-Edit`)

## Configuration

Environment variables use the `ENGINE_` prefix (and optional `.env` file):

| Variable                   | Default    | Description                         |
| :------------------------- | :--------- | :---------------------------------- |
| `ENGINE_HOST`              | `0.0.0.0`  | Server bind host                    |
| `ENGINE_PORT`              | `8000`     | Server listen port                  |
| `ENGINE_WORKERS`           | `1`        | Uvicorn worker count                |
| `ENGINE_ACCESS_LOG`        | `false`    | Enable HTTP access logging          |
| `ENGINE_LOG_LEVEL`         | `info`     | Uvicorn log level                   |
| `ENGINE_DEVICE`            | `cuda`     | Target inference device             |
| `ENGINE_DTYPE`             | `bfloat16` | Inference tensor dtype              |
| `ENGINE_WARMUP_ON_STARTUP` | `true`     | Preload/warmup models in `lifespan` |

## Speed-First Guidelines

1. **Zero-copy / binary media transport**: Use binary WebSocket frames (`bytes` / `memoryview`) for audio PCM chunks and video frames. Never base64-encode or JSON-wrap media payloads on the hot path.
2. **Never block the event loop**: Offload CPU-bound pre/post-processing and synchronous CUDA calls to dedicated threads/executors or CUDA streams so WebSocket heartbeats and concurrent streams stay responsive.
3. **GPU inference defaults**:
   - Preload weights and run warmup passes during FastAPI `lifespan` startup before marking `/ready` healthy.
   - Wrap inference in `torch.inference_mode()` with `bfloat16`/`float16` autocast where supported.
   - Reuse pre-allocated pinned host buffers and GPU tensors; avoid per-frame allocations.
4. **Vendor boundaries**: Import or wrap `vendor/JoyAI-Video-Edit` and `vendor/seed-vc` from `apps/engine-py` without modifying `vendor/` directly (see [submodules.md](submodules.md)).

## Commands

Run from the repository root:

| Command                                              | Action                                   |
| :--------------------------------------------------- | :--------------------------------------- |
| `uv sync --all-packages`                             | Sync workspace dependencies into `.venv` |
| `uv run --package metamorph-engine metamorph-engine` | Start the inference server               |
| `pnpm format:check && pnpm lint && pnpm typecheck`   | Full repo verification                   |
