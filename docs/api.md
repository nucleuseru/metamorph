# API Server (`apps/api`)

`@metamorph/api` is the Effect v4 TypeScript HTTP server in `apps/api`.

## Stack & Effect v4 Conventions

- **Runtime**: Node.js (`>=22.19`, runs TypeScript natively via `node --watch src/index.ts` in dev)
- **Framework**: Effect `4.1.5` + `@effect/platform-node` `4.1.5`
- **v4 Module Layout**:
  - Core primitives (`Effect`, `Layer`, `Context`, `Config`, `Schema`): `"effect"`
  - HTTP routing & client (`HttpRouter`, `HttpServerResponse`, `HttpClient`): `"effect/http"`
  - Schema-first HTTP APIs (`HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, `HttpApiBuilder`, `HttpApiScalar`, `OpenApi`): `"effect/http-api"`
  - Node server & runtime (`NodeHttpServer`, `NodeRuntime`): `"@effect/platform-node"`
- **TypeScript**: `apps/api/tsconfig.json` extends `../../tsconfig.base.json` with `rewriteRelativeImportExtensions: true` so `.ts` relative imports work in both native Node execution and `tsc -p tsconfig.build.json` builds.

## Endpoints

- `GET /health` — Health check returning `{ "status": "ok" }`
- `GET /openapi.json` — Generated OpenAPI specification
- `GET /docs` — Scalar API documentation UI

## Configuration

| Variable | Default | Description             |
| :------- | :------ | :---------------------- |
| `PORT`   | `3001`  | HTTP server listen port |

## Commands

| Command                                            | Action                           |
| :------------------------------------------------- | :------------------------------- |
| `pnpm --filter @metamorph/api dev`                 | Start dev server with `--watch`  |
| `pnpm --filter @metamorph/api build`               | Compile to `dist/`               |
| `pnpm --filter @metamorph/api start`               | Run compiled `dist/index.js`     |
| `pnpm --filter @metamorph/api typecheck`           | Run `tsc --noEmit`               |
| `pnpm format:check && pnpm lint && pnpm typecheck` | Full repo verification from root |

## Effect v4 Reference Docs

Effect v4 includes major API changes from v3. Always consult `apps/api/node_modules/effect/AGENTS.md` and `apps/api/node_modules/effect/ai-docs/` for up-to-date patterns (`Effect.fn`, `Context.Service`, `Schema.TaggedError`, `HttpApi`, `Layer.launch`).
