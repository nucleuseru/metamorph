# Monorepo Architecture

`metamorph` combines **pnpm workspaces**, **uv workspaces**, and **Turborepo** in a single repository.

## Workspaces

### TypeScript / JavaScript (`pnpm`)

Configured in `pnpm-workspace.yaml`:

- `apps/*`
- `packages/*`

TypeScript packages extend `tsconfig.base.json` and live under `packages/` or `apps/`. Workspace packages use the `@metamorph/*` scope:

- `@metamorph/shared` (`packages/shared-ts`) — Isomorphic 16-byte `!BBHIQ` binary wire protocol and shared Effect Schemas for engine/API communication
- `@metamorph/orchestrator` (`packages/orchestrator`) — Effect v4 GPU instance orchestrator (`RunPod`, `Vast.ai`, `local`), hardware sizing, engine HTTP client, webhooks, and reconciler

### Python (`uv`)

Configured in root `pyproject.toml` (`[tool.uv.workspace]`):

- `apps/*-py`
- `packages/*-py`

Python version is pinned via `.python-version` (`3.12`, `requires-python = ">=3.12"`). All Python dependencies and workspace members resolve into a single root `.venv/` and `uv.lock`.

**Why `*-py`?** `uv` errors if a directory matched by workspace globs lacks a `pyproject.toml`. Naming Python workspace members `*-py` allows TypeScript and Python projects to coexist cleanly under `apps/` and `packages/`.

## Adding a New Package

Use Turborepo's custom generators in `turbo/generators/config.ts` to scaffold either package type:

```bash
pnpm gen                         # Interactive selector (ts-package or py-package)
pnpm turbo gen ts-package        # TypeScript package (@metamorph/<name>)
pnpm turbo gen py-package        # Python package (packages/<name>-py)
```

Or pass the package name directly with `--args`:

```bash
pnpm turbo gen ts-package --args <name>
pnpm turbo gen py-package --args <name>
```

### New TypeScript Package

1. Create `packages/<name>/package.json` with `"name": "@metamorph/<name>"` and a `"typecheck": "tsc --noEmit"` script.
2. Create `packages/<name>/tsconfig.json` extending `../../tsconfig.base.json`.
3. Run `pnpm install` to link the workspace package.

### New Python Package

1. Create `packages/<name>-py/pyproject.toml` (or `apps/<name>-py/pyproject.toml`) with `requires-python = ">=3.12"`.
2. Add source under `src/<pkg_name>/`.
3. Run `uv sync` at the repo root to register the member in `uv.lock`.

## Task Orchestration (`turbo.json`)

Turborepo enables `futureFlags.experimentalPythonWorkspaces` so it discovers both `pnpm` workspaces and `uv` workspace members (with root `[tool.turbo].name = "metamorph-python"` in `pyproject.toml`):

- `build`: `dependsOn: ["^build"]`, caches `dist/**`, `build/**`, and `.next/**` (and `uv build` for Python packages)
- `typecheck`: `dependsOn: ["^build", "^typecheck"]` (JS/TS packages); Python typechecking uses Turborepo's built-in `check` / `check:ty` task
- `test`: `dependsOn: ["^build"]` (with `metamorph-python#test` overriding `dependsOn: []` to run `pytest` across all Python workspace packages)
- `lint` / `format`: Turborepo's built-in Python tasks map to `ruff check` (`lint:ruff`) and `ruff format` (`format:ruff`)
- `dev`: `persistent: true`, `cache: false`

## Root Commands

| Command             | Action                                                                          |
| :------------------ | :------------------------------------------------------------------------------ |
| `pnpm lint`         | Run `oxlint` and `turbo run lint:ruff`                                          |
| `pnpm format`       | Format all TS/JS/JSON/MD (`oxfmt --write`) and Python (`turbo run format:ruff`) |
| `pnpm format:check` | Check formatting without writing                                                |
| `pnpm typecheck`    | Run `turbo run typecheck` (TS) and `turbo run check:ty` (Python)                |
| `pnpm build`        | Run `turbo run build`                                                           |
| `pnpm test`         | Run `turbo run test`                                                            |
| `pnpm dev`          | Run `turbo run dev`                                                             |
| `pnpm gen`          | Run `turbo gen` (`ts-package` or `py-package` generators)                       |
