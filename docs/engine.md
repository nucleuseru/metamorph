# Inference Engine (`apps/engine-py`)

`metamorph-engine` (`apps/engine-py`) is the low-latency single-user Python GPU inference server deployed to dedicated GPU instances. It hosts:

- **Real-time voice cloning** (`vendor/seed-vc` v1 real-time model + SOLA crossfade + RMS VAD)
- **Full-body swap & RV2V / V2V video editing** (`vendor/JoyAI-Video-Edit` streaming DiT + xVAE pipeline)
- **Adaptive A/V synchronization** aligning voice and video emission using microsecond capture PTS

## Stack

- **Framework & Server**: FastAPI + `uvicorn` (`uvloop`, `httptools`, `websockets`)
- **Configuration**: `pydantic-settings` (`EngineSettings` in [`config.py`](../apps/engine-py/src/metamorph_engine/config.py))
- **Authentication**: Asymmetric **EdDSA (Ed25519)** JWT verification (`JWTAuthenticator` in [`auth.py`](../apps/engine-py/src/metamorph_engine/auth.py))

## Endpoints

### Public Probes

- `GET /health` — Liveness probe returning `{"status": "ok", "instance_id", "backend", "enabled_modalities"}`.
- `GET /ready` — Readiness probe returning `503` (`warming` or `shutting_down`) until startup warmup completes, then `200` (`ready`).

### Authenticated HTTP Control (`/session`, `Authorization: Bearer <jwt>`)

- `GET /session/status` — Instance lifecycle state, remaining idle/disconnect countdowns, staged reference assets, and live A/V sync telemetry.
- `POST /session/config` — Update prompt, `ref_image_url` / `ref_image_base64` / `clear_ref_image`, `ref_audio_url` / `ref_audio_base64`, and video/audio overrides; hot-swaps active WebSocket streams without instance reprovisioning.
- `POST /session/assets` — Multipart `form-data` upload for `prompt`, `ref_image`, and/or `ref_audio` with hot-swap support.
- `POST /session/shutdown` — Trigger immediate graceful teardown and signed lifecycle webhook delivery.

### Multiplexed Binary WebSocket (`WS /ws/session`)

Single multiplexed WebSocket connection carrying both JSON control messages and binary media frames.

#### Authentication Handshake

- **Browser / default**: Connect to `WS /ws/session` and send `{"type": "auth", "token": "<jwt>"}` as the first text frame within `ENGINE_WS_AUTH_TIMEOUT_S` (default `5s`).
- **Header fallback**: Non-browser clients may pass `Authorization: Bearer <jwt>` on the WebSocket upgrade request.
- **Token refresh**: Send `{"type": "auth_refresh", "token": "<new_jwt>"}` mid-session to extend `exp` without interrupting streaming.

#### 16-Byte Binary Media Frame Header (`!BBHIQ`, Big-Endian)

| Offset | Size | Field         | Description                                                                                                       |
| :----- | :--- | :------------ | :---------------------------------------------------------------------------------------------------------------- |
| `0`    | `1`  | `version`     | Protocol version (`1`)                                                                                            |
| `1`    | `1`  | `track_codec` | High nibble: Track (`1`=Video, `2`=Audio). Low nibble: Video (`2`=MJPEG) or Audio (`1`=PCM16 LE mono)             |
| `2`    | `2`  | `flags`       | Bitmask: `0x0001`=KEYFRAME, `0x0002`=END_OF_CHUNK, `0x0004`=SILENCE, `0x0008`=PASSTHROUGH, `0x0010`=SPEECH_ACTIVE |
| `4`    | `4`  | `seq`         | Monotonic frame/chunk sequence number (`uint32`)                                                                  |
| `8`    | `8`  | `pts_us`      | Capture presentation timestamp in microseconds (`uint64`)                                                         |
| `16`   | `N`  | `payload`     | Raw media payload (JPEG bytes or PCM16 LE samples)                                                                |

#### Control Messages (JSON Text Frames)

- **Client -> Server**: `auth`, `auth_refresh`, `start` (optional `prompt`, `ref_image_*`, `ref_audio_*`, `video`, `audio`), `update_config`, `ping`, `stop`.
- **Server -> Client**: `auth_ok`, `started`, `config_updated`, `pong`, `sync_stats`, `dropped`, `session_superseded`, `stopped`, `error`.

## JWT Claims Contract (`apps/api` -> `apps/engine-py`)

Tokens are **EdDSA (Ed25519)** JWTs minted by [`EngineTokenService`](../apps/api/src/services/engine-tokens.ts) in `apps/api`. The engine verifies them using either or both of:

- `ENGINE_JWT_PUBLIC_KEY`: Escaped SPKI Ed25519 PEM (`-----BEGIN PUBLIC KEY-----\n...`) injected into spawned containers by `@metamorph/orchestrator` for zero-roundtrip offline verification.
- `ENGINE_JWT_JWKS_URL` (e.g. `https://api.example.com/.well-known/engine-jwks.json`): Public JWKS endpoint served by `apps/api`; keys are selected by `kid`, cached for `ENGINE_JWT_JWKS_CACHE_TTL_S` (default `300`), and also serve as fallback when a primary signing key is rotated.

Claims:

- `sub` (`string`, required): User ID; verified against `ENGINE_USER_ID` (or bound to the first user in dev).
- `aud` (`string`): Verified against `ENGINE_JWT_AUDIENCE` when set (set to `instanceId` by `@metamorph/orchestrator`); not checked when `ENGINE_JWT_AUDIENCE` is unset.
- `iss` (`string`, optional): Verified when `ENGINE_JWT_ISSUER` is configured.
- `exp` (`number`, required): Expiration timestamp (checked on HTTP, WS auth, and mid-session).
- `modalities` (`("voice" | "video")[]`, optional): Defaults to enabled instance modalities; any requested modality not enabled on the instance returns `403` / WS `4003`.

## Lifecycle, Single-User Takeover & Signed Webhooks

- **States**: `booting` -> `ready_idle` -> `active` <-> `disconnect_grace` -> `shutting_down`.
- **Timeouts**:
  - `ENGINE_STARTUP_IDLE_TIMEOUT_S` (`120s` default): shuts down if no user connects after warmup.
  - `ENGINE_DISCONNECT_TIMEOUT_S` (`30s` default): shuts down if the user disconnects and does not reconnect before the grace window expires.
- **Single-user takeover**: Opening a new authenticated WebSocket for the same `sub` cleanly closes the stale socket (`4009`, `session_superseded`) without triggering the disconnect countdown.
- **Lifecycle webhooks**: When `ENGINE_LIFECYCLE_WEBHOOK_URL` is configured, POSTs JSON events (`ready`, `connected`, `disconnected`, `shutting_down`) signed with `X-Metamorph-Signature: sha256=<hmac-sha256>` using `ENGINE_LIFECYCLE_WEBHOOK_SECRET`.

## Docker & GPU Deployment

### Multi-Target Image ([Dockerfile](../apps/engine-py/Dockerfile))

Images are built from the **repository root** via [engine-docker.yml](../.github/workflows/engine-docker.yml) (or `docker build -f apps/engine-py/Dockerfile --target <target> .`):

| Target  | Base Image         | Purpose                                                                                                           |
| :------ | :----------------- | :---------------------------------------------------------------------------------------------------------------- |
| `full`  | `ubuntu:22.04`     | Voice + RV2V/V2V GPU image (`JoyAI-Video-Edit` + `joyomni_ops` FP8 + `Seed-VC`; built in CUDA 12.8 devel builder) |
| `voice` | `python:3.12-slim` | Slim voice-only image (`ENGINE_ENABLE_VIDEO=false`; self-contained CUDA 12.8 via PyTorch cu128 wheels)            |
| `mock`  | `python:3.12-slim` | Lightweight CPU mock image (`ENGINE_BACKEND=mock`) for local `apps/api` dev                                       |

```bash
# Local CPU mock image
docker build -f apps/engine-py/Dockerfile --target mock -t metamorph-engine:mock .
docker run --rm -p 8000:8000 --env-file apps/engine-py/.env metamorph-engine:mock
```

### Model Volume Layout & Pre-Population

Weights and per-GPU Triton/TorchInductor compile caches are mounted externally at `/models` (or `/workspace`, or via `MODEL_VOLUME_DIR`) so containers pull quickly:

```text
/models/
├── checkpoints/
│   ├── JoyAI-Video-Edit/
│   │   ├── dit/joyai_video_edit_dit_1101_face++.pth
│   │   └── vae/{config.json, diffusion_pytorch_model.safetensors}
│   ├── MiMo-VL-7B-RL-2508/
│   └── seed-vc/
├── hf_cache/
├── torch_cache/
└── cache/
    ├── <gpu_slug>.tar.zst               # compressed TorchInductor/Triton/NV cache archive (fast FUSE extract)
    ├── <gpu_slug>.compile_mode          # compile mode marker for the archive
    └── <gpu_slug>/                      # isolated local/unpacked torchinductor/triton/nv_compute caches
```

Populate a volume once using [`download_models.sh`](../apps/engine-py/scripts/download_models.sh) (which also prunes XLSR-300M to 12-layer float16 safetensors via [`prune_xlsr.py`](../apps/engine-py/scripts/prune_xlsr.py)), or set `AUTO_DOWNLOAD_MODELS=true` on boot.

To pre-warm a `max-autotune-no-cudagraphs` GPU compile archive once per GPU SKU (recommended for RTX 5090 / RTX PRO 6000 so production pods extract `<gpu_slug>.tar.zst` in ~1–2s and hit cached kernels immediately):

```bash
/app/scripts/prewarm_cache.sh --res 840x480
```

Voice-only images (`:voice`) bake pruned XLSR-L12 and stripped full-precision Seed-VC checkpoints into `/app/bundled_models/seed-vc` by default (`BUNDLE_VOICE_WEIGHTS=1`), eliminating FUSE and HuggingFace API calls during voice startup.

### CI/CD (GitHub Actions -> Docker Hub)

[engine-docker.yml](../.github/workflows/engine-docker.yml) runs `pytest`, `ruff`, and `ty`, then builds and pushes `mock`, `voice`, and `full` images on pushes to `main`, `engine-v*` tags, and manual `workflow_dispatch` runs (PRs build and smoke-test `mock` without pushing).

- **Required Secrets**: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (plus optional `SUBMODULES_TOKEN` if vendor submodules are private).
- **Optional Repository Variable**: `DOCKERHUB_IMAGE` (defaults to `metamorph-engine`).
- **Published Tags**: `:<target>` (`full`, `voice`, `mock`) and `:latest` (`full`) on `main`, `:<target>-sha-<short>`, plus semver tags on `engine-v*` releases.
- **Manual Dispatch Inputs**: Select `targets` (`all` | `full` | `voice` | `mock`), `cuda_archs`, `build_fp8`, `install_sage_attn`, `install_fa4`, `max_jobs`, and `push`.

### Container Runtime Contract (`apps/api`)

- **Targets & CUDA**: `full` (voice + video), `voice` (voice-only), `mock` (CPU dev); `full` and `voice` require CUDA 12.8+.
- **Port & Volume**: Exposes container port `8000` (`0.0.0.0:8000`); mount checkpoints/caches at `/models` (auto-falls back to `/workspace`, or override with `MODEL_VOLUME_DIR`).
- **Required `ENGINE_*` env vars**:
  - `ENGINE_INSTANCE_ID`, `ENGINE_USER_ID`
  - `ENGINE_ENABLE_VOICE` (`"true"`/`"false"`), `ENGINE_ENABLE_VIDEO` (`"true"`/`"false"`)
  - `ENGINE_JWT_PUBLIC_KEY` and/or `ENGINE_JWT_JWKS_URL` (plus `ENGINE_JWT_AUDIENCE` / optional `ENGINE_JWT_ISSUER`)
  - `ENGINE_LIFECYCLE_WEBHOOK_URL`, `ENGINE_LIFECYCLE_WEBHOOK_SECRET`
  - Optional bootstrap: `ENGINE_INITIAL_PROMPT`, `ENGINE_INITIAL_REF_IMAGE_URL`, `ENGINE_INITIAL_REF_AUDIO_URL`

#### Modality -> Image & GPU Sizing

| Modalities (`ENGINE_ENABLE_*`)             | Image Target | Minimum / Recommended GPU                                                                                      | Notes                                                                                                             |
| :----------------------------------------- | :----------- | :------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| Voice only (`VOICE=true`, `VIDEO=false`)   | `:voice`     | `>=8 GB` CUDA 12.8+ GPU (smallest available: RTX 3070 / 3080 / 4070 Ti / RTX 2000 Ada / A4000 / L4)            | Runs `Seed-VC` (`~2–2.5 GiB` VRAM)                                                                                |
| Video only (`VOICE=false`, `VIDEO=true`)   | `:full`      | `>=32 GB` GPU (**RTX 5090** for `480p24`, `PE=none`; `>=48 GB` / **RTX PRO 6000** for `720p` or local Qwen PE) | JoyAI `480p24` low-VRAM uses `~21.5 GiB` resident / `~28 GiB` peak; SageAttention 2.2.0 is bundled for 5090       |
| Video + Voice (`VOICE=true`, `VIDEO=true`) | `:full`      | **`>=48 GB` VRAM (recommended: RTX PRO 6000 96 GB)**                                                           | Combined JoyAI (`~28 GiB` peak) + Seed-VC (`~2–2.5 GiB`) leaves minimal VRAM/compute headroom on a 32 GB RTX 5090 |

## Key Configuration (`ENGINE_*`)

| Variable                                                        | Default                   | Description                                                                                                                                                                                |
| :-------------------------------------------------------------- | :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENGINE_HOST` / `ENGINE_PORT`                                   | `0.0.0.0` / `8000`        | Bind address and port                                                                                                                                                                      |
| `ENGINE_INSTANCE_ID` / `ENGINE_USER_ID`                         | `local-instance` / `None` | Dedicated instance and user binding                                                                                                                                                        |
| `ENGINE_ENABLE_VOICE` / `ENGINE_ENABLE_VIDEO`                   | `true` / `true`           | Modalities loaded at boot                                                                                                                                                                  |
| `ENGINE_BACKEND`                                                | `gpu`                     | `gpu` (Seed-VC + JoyAI) or `mock` (CPU testing)                                                                                                                                            |
| `ENGINE_JWT_PUBLIC_KEY` / `ENGINE_JWT_JWKS_URL`                 | `None` / `None`           | Static SPKI Ed25519 PEM and/or `apps/api` JWKS URL                                                                                                                                         |
| `ENGINE_JWT_JWKS_CACHE_TTL_S`                                   | `300`                     | JWKS key cache TTL in seconds                                                                                                                                                              |
| `ENGINE_JWT_ISSUER` / `ENGINE_JWT_AUDIENCE`                     | `None` / `None`           | Expected JWT `iss` and `aud` claims                                                                                                                                                        |
| `ENGINE_STARTUP_IDLE_TIMEOUT_S` / `ENGINE_DISCONNECT_TIMEOUT_S` | `120.0` / `30.0`          | Idle and disconnect shutdown timeouts                                                                                                                                                      |
| `ENGINE_LIFECYCLE_WEBHOOK_URL` / `_SECRET`                      | `None`                    | Signed lifecycle webhook destination                                                                                                                                                       |
| `ENGINE_INITIAL_PROMPT` / `_REF_IMAGE_URL` / `_REF_AUDIO_URL`   | `None`                    | Startup reference asset bootstrap                                                                                                                                                          |
| `ENGINE_VIDEO_WIDTH` / `_HEIGHT` / `_FPS`                       | `840` / `480` / `24`      | Video streaming resolution and FPS                                                                                                                                                         |
| `ENGINE_VIDEO_COMPILE_MODE`                                     | `auto`                    | xVAE `torch.compile` mode (`auto`/`default`/`reduce-overhead`/`max-autotune-no-cudagraphs`/`none`); `auto` reuses `max-autotune-no-cudagraphs` only when seeded from cache, else `default` |
| `ENGINE_VIDEO_WARMUP_BOTH_ORIENTATIONS`                         | `false`                   | When `false`, warms only the configured orientation instead of landscape + portrait                                                                                                        |
| `ENGINE_VIDEO_SKIP_REF_IMAGE_COMPILE`                           | `true`                    | Runs one-shot reference-image VAE encode eager instead of compiling 49 bucket shapes                                                                                                       |
| `ENGINE_VIDEO_PERSIST_COMPILE_CACHE`                            | `true`                    | Asynchronously saves local `/tmp` compile cache back to `<volume>/cache/<gpu_slug>.tar.zst`                                                                                                |
| `ENGINE_VOICE_SAMPLE_RATE` / `_VAD_BACKEND`                     | `22050` / `rms`           | Seed-VC sample rate and VAD mode (`rms` or `none`)                                                                                                                                         |
| `ENGINE_VOICE_DIFFUSION_STEPS` / `_WARMUP_DIFFUSION_STEPS`      | `20` / `2`                | Seed-VC live Euler ODE steps and fast startup warmup steps                                                                                                                                 |
| `ENGINE_VOICE_PARALLEL_LOAD` / `_CFG_RATE`                      | `true` / `0.7`            | Concurrent CPU checkpoint loading and classifier-free guidance rate                                                                                                                        |
| `ENGINE_VOICE_BLOCK_TIME_S` / `_CROSSFADE_S`                    | `0.32` / `0.08`           | Streaming chunk length and SOLA crossfade window                                                                                                                                           |
| `ENGINE_VOICE_MAX_PROMPT_LENGTH_S` / `_DTYPE`                   | `8.0` / `auto`            | Max reference audio prompt duration and precision (`auto`/`float16`/`bfloat16`/`float32`)                                                                                                  |
| `ENGINE_AV_SYNC_ENABLED` / `_MAX_HOLD_S`                        | `true` / `1.0`            | Adaptive dual-modality A/V sync controls                                                                                                                                                   |

## Commands

Run from the repository root:

| Command                                              | Action                                            |
| :--------------------------------------------------- | :------------------------------------------------ |
| `uv sync --all-packages`                             | Sync workspace runtime and dev/test dependencies  |
| `uv sync --all-packages --extra gpu`                 | Install optional CUDA/ML packages on GPU hosts    |
| `uv run pytest -v`                                   | Run full CPU test suite (`ENGINE_BACKEND=mock`)   |
| `uv run --package metamorph-engine metamorph-engine` | Start the inference server                        |
| `pnpm format:check && pnpm lint && pnpm typecheck`   | Full repo formatting, lint, and type verification |
