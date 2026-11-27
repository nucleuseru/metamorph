# API Server (`apps/api`)

`@metamorph/api` is the Effect v4 TypeScript HTTP & WebSocket API server in `apps/api`. It coordinates authentication, reference media assets, saved personas, and on-demand GPU engine orchestration via [`@metamorph/orchestrator`](../packages/orchestrator) and [`@metamorph/shared`](../packages/shared-ts).

## Stack & Effect v4 Conventions

- **Runtime**: Node.js (`>=22.19`, runs TypeScript natively via `node --watch src/index.ts` in dev)
- **Framework**: Effect `4.1.5` + `@effect/platform-node` `4.1.5`
- **v4 Module Layout**:
  - Core primitives (`Effect`, `Layer`, `Context`, `Config`, `Schema`, `PubSub`): `"effect"`
  - HTTP routing, multipart & client (`HttpRouter`, `HttpServerResponse`, `HttpClient`, `Multipart`): `"effect/http"`
  - Schema-first HTTP APIs & SSE (`HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, `HttpApiBuilder`, `HttpApiSchema`, `HttpApiScalar`, `OpenApi`): `"effect/http-api"`
  - JOSE / Cryptography (`Jwk`, `Jwt`, `Mac`, `Signature`): `"effect/jose"`, `"effect/crypto"`
  - WebSocket (`Socket`, `NodeWS`): `"effect/socket"`, `"@effect/platform-node"`
- **Workspace Packages**: `@metamorph/shared` (`packages/shared-ts`), `@metamorph/orchestrator` (`packages/orchestrator`).
- **TypeScript**: `apps/api/tsconfig.json` extends `../../tsconfig.base.json` with `rewriteRelativeImportExtensions: true` so `.ts` relative imports work in both native Node execution and `tsc -p tsconfig.build.json` builds.

## Endpoints

### System & Auth

- `GET /health` — Health check returning `{ "status": "ok" }`
- `GET /.well-known/engine-jwks.json` — Public Ed25519 JWKS used by `engine-py` instances to verify instance-scoped session tokens
- `GET /me` — Current user (`id`, `email`, `name`, `emailVerified`, `image`); requires a Better Auth session (cookie) and returns `401` otherwise
- `ALL /api/auth/*` — [Better Auth](https://better-auth.com) handler:
  - Google: `POST /api/auth/sign-in/social` with `{ "provider": "google" }` (callback `/api/auth/callback/google`)
  - Better Auth JWT: `GET /api/auth/token` and `GET /api/auth/jwks`
- `GET /openapi.json` — Generated OpenAPI specification
- `GET /docs` — Scalar API documentation UI

### Reference Assets (`/assets`, Authenticated)

- `POST /assets` — Direct multipart upload (`kind`: `"ref_image"` | `"ref_audio"`, optional `name`, `file`). Validates MIME types (`jpeg`/`png`/`webp` <= 15 MiB, `wav`/`mp3`/`flac`/`ogg`/`m4a`/`webm` <= 25 MiB) and stores in S3 `ObjectStorage`.
- `GET /assets?kind=` — List user assets with short-lived signed download URLs.
- `GET /assets/:id` — Fetch single asset metadata and signed download URL.
- `DELETE /assets/:id` — Delete asset metadata and stored object.

### Personas / Presets (`/personas`, Authenticated)

- `POST /personas` — Create a reusable persona (`name`, `modalities`, `prompt`, `refImageAssetId`, `refAudioAssetId`, `videoConfig`, `audioConfig`).
- `GET /personas` — List user personas with hydrated signed asset URLs.
- `GET /personas/:id` — Get single persona.
- `PATCH /personas/:id` — Update persona fields/assets.
- `DELETE /personas/:id` — Delete persona.

### Real-Time Sessions & Engine Control (`/sessions`, Authenticated)

- `POST /sessions` — Provision an on-demand dedicated GPU instance (1 active session per user; `409` on conflict). Accepts `modalities` (`["voice"]`, `["video"]`, or `["voice", "video"]`), `quality` (`"standard"` 480p24 | `"high"` 720p24), optional `personaId`, reference assets/URLs, and initial config overrides. Returns session metadata, `connection` info (`mode`: `"direct"` or `"relay"`, `wsUrl`, `directWsUrl`, `relayWsUrl`, `httpUrl`, `token`, `tokenExpiresAt`), and `initialConfig`.
- `GET /sessions?includeEnded=&limit=` — List user sessions.
- `GET /sessions/active` — Get the current active session (`null` if none).
- `GET /sessions/:id` — Get session details and fresh connection token.
- `POST /sessions/:id/token` — Mint a fresh instance-scoped EdDSA JWT (`sub`, `aud: instanceId`, `iss`, `modalities`, `exp`) for connecting or refreshing `auth_refresh` on `/ws/session`.
- `GET /sessions/:id/status` — Proxy live `GET /session/status` telemetry from the running GPU engine.
- `PATCH /sessions/:id/config` — Hot-swap prompt, persona (`personaId`), asset IDs/URLs/base64, or video/audio parameters on the active engine via `POST /session/config` (and broadcast `session_config_updated` over SSE).
- `POST /sessions/:id/assets` — Forward multipart `prompt`, `clear_ref_image`, `ref_image`, and/or `ref_audio` hot-swap to the running engine's `POST /session/assets`.
- `DELETE /sessions/:id` — Stop the session, call best-effort engine `/session/shutdown`, terminate the GPU provider instance, and finalize usage/cost metrics.
- `GET /sessions/:id/events` — Server-Sent Events (`text/event-stream`) streaming initial state snapshot and live updates (`session_status`, `session_ready`, `session_config_updated`, `session_stopped`, `session_failed`).
- `GET /sessions/:id/ws` — Transparent bidirectional WebSocket relay (auth via Better Auth session cookie or `?token=<jwt>`) preserving text (JSON control) and binary (`!BBHIQ` 16-byte media) WebSocket frames for providers without TLS (e.g. Vast.ai direct IP).

### Usage & Engine Webhooks

- `GET /usage/summary` — Aggregate active/completed session counts, active seconds, and estimated GPU cost broken down by provider and modality.
- `POST /internal/webhooks/engine/:instanceId` — Internal endpoint verifying `X-Metamorph-Signature: sha256=<hex>` HMAC signatures on raw JSON events (`ready`, `connected`, `disconnected`, `shutting_down`) emitted by `apps/engine-py`.

## Authentication, Orchestration & Database

- **Database**: Drizzle ORM (`drizzle-orm/effect-postgres` + `@effect/sql-pg`) via [`apps/api/src/services/db.ts`](../apps/api/src/services/db.ts). Schema lives in [`apps/api/src/db/schema.ts`](../apps/api/src/db/schema.ts), [`apps/api/src/db/auth-schema.ts`](../apps/api/src/db/auth-schema.ts), and [`apps/api/src/db/app-schema.ts`](../apps/api/src/db/app-schema.ts).
  - Push schema in dev: `pnpm --filter @metamorph/api db:push`
  - Generate & apply SQL migrations: `pnpm --filter @metamorph/api db:generate && pnpm --filter @metamorph/api db:migrate`
  - Regenerate Better Auth tables after plugin changes: `pnpm --filter @metamorph/api auth:schema`
- **Engine JWTs**: [`EngineTokenService`](../apps/api/src/services/engine-tokens.ts) signs EdDSA (Ed25519) JWTs scoped to `aud: instanceId` using `ENGINE_JWT_PRIVATE_KEY` or an auto-generated Ed25519 keypair stored AES-256-GCM encrypted in `engine_signing_key` (derived from `BETTER_AUTH_SECRET`). The public key PEM is injected into spawned containers via `ENGINE_JWT_PUBLIC_KEY`.
- **Orchestrator**: [`@metamorph/orchestrator`](../packages/orchestrator) supports **RunPod REST v2**, **Vast.ai REST v0**, and **Local/Static** providers with ordered failover, readiness polling, signed webhook ingestion, and a scoped background orphan/timeout reconciler (`ReconcilerLayer`).
- **Tests**: `pnpm --filter @metamorph/api test` (offline: in-memory repositories, ephemeral Ed25519 keys, mocked HTTP/WS engine servers).

## Configuration

Copy [`apps/api/.env.example`](../apps/api/.env.example) to `apps/api/.env` (loaded by `dev`/`start` via `--env-file-if-exists`).

| Variable                                                                 | Default                         | Description                                                      |
| :----------------------------------------------------------------------- | :------------------------------ | :--------------------------------------------------------------- |
| `PORT` / `API_PUBLIC_URL`                                                | `3001` / `BETTER_AUTH_URL`      | Listen port and public API base URL for webhooks/assets/WS relay |
| `DATABASE_URL`                                                           | required                        | PostgreSQL connection string                                     |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `BETTER_AUTH_TRUSTED_ORIGINS` | required / localhost            | Auth secret, base URL, and CORS/CSRF origins                     |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                              | unset                           | Enables Google sign-in when both are set                         |
| `JWT_ISSUER` / `JWT_AUDIENCE` / `JWT_EXPIRATION_TIME`                    | base URL / base URL / `15m`     | Claims and TTL of minted JWTs                                    |
| `ENGINE_JWT_PRIVATE_KEY` / `ENGINE_JWT_JWKS_URL`                         | unset                           | Optional static Ed25519 PKCS#8 key and JWKS URL for engine-py    |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE`        | required / `us-east-1`          | S3-compatible object storage configuration                       |
| `ORCHESTRATOR_PROVIDERS` / `ORCHESTRATOR_ALLOW_OVERRIDES`                | `runpod,vastai,local` / `false` | Ordered GPU provider failover list and override toggle           |
| `RUNPOD_API_KEY` / `RUNPOD_API_URL` / `RUNPOD_CLOUD_TYPE`                | unset / v2 / `SECURE`           | RunPod REST v2 credentials and placement options                 |
| `VASTAI_API_KEY` / `VASTAI_API_URL` / `VASTAI_MAX_PRICE_PER_HR`          | unset / v0 / unset              | Vast.ai REST v0 credentials and price/proxy options              |
| `LOCAL_ENGINE_URL` / `LOCAL_ENGINE_WS_URL`                               | `http://127.0.0.1:8000`         | Local/static dev `engine-py` server URL                          |
| `ORCHESTRATOR_STARTUP_TIMEOUT_S` / `ORCHESTRATOR_MAX_SESSION_DURATION_S` | `300` / `7200`                  | Provisioning timeout and hard max session duration guardrail     |

## Commands

Run from the repository root:

| Command                                            | Action                           |
| :------------------------------------------------- | :------------------------------- |
| `pnpm --filter @metamorph/api dev`                 | Start dev server with `--watch`  |
| `pnpm --filter @metamorph/api build`               | Compile to `dist/`               |
| `pnpm --filter @metamorph/api start`               | Run compiled `dist/index.js`     |
| `pnpm --filter @metamorph/api test`                | Run API test suite               |
| `pnpm --filter @metamorph/api typecheck`           | Run `tsc --noEmit`               |
| `pnpm format:check && pnpm lint && pnpm typecheck` | Full repo verification from root |

### Docker

Build the production image from the **repository root** using [`apps/api/Dockerfile`](../apps/api/Dockerfile) (and [`apps/api/Dockerfile.dockerignore`](../apps/api/Dockerfile.dockerignore), which keeps the root `.dockerignore` scoped to `engine-py`):

```bash
docker build -f apps/api/Dockerfile -t metamorph-api .
```

The image uses `turbo prune @metamorph/api --docker` to install only `@metamorph/api`, `@metamorph/orchestrator`, and `@metamorph/shared` dependencies and runs `node dist/index.js` on port `3001` as a non-root user.

## Effect v4 Reference Docs

Effect v4 includes major API changes from v3. Always consult `apps/api/node_modules/effect/AGENTS.md` and `apps/api/node_modules/effect/ai-docs/` for up-to-date patterns (`Effect.fn`, `Context.Service`, `Schema.TaggedError`, `HttpApi`, `Layer.launch`).
