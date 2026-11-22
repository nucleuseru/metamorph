# AGENTS.md

`metamorph` is a TypeScript and Python monorepo for real-time body swapping, voice cloning, and video editing.

## Rules

1. **Package managers**: Use `pnpm` for Node/TypeScript and `uv` for Python. Never use `npm`, `yarn`, `pip`, or `poetry`.
2. **Python workspace naming**: Python apps and packages under `apps/` or `packages/` **must** end with `-py` (e.g., `apps/engine-py`, `packages/shared-py`).
3. **Tooling**: Use the root-configured tools (`oxfmt`, `oxlint`, `tsc`, `ruff`, `ty`). Do not add per-app ESLint, Prettier, Black, or mypy configs.
4. **Vendor submodules**: Do not format, lint, or directly modify `vendor/` unless explicitly tasked with patching upstream code.
5. **Verify before finishing**: Run `pnpm format:check && pnpm lint && pnpm typecheck` after code or config changes.

## Documentation

Read only the relevant doc for your task:

- [docs/monorepo.md](docs/monorepo.md) — Workspace layout, Turborepo pipelines, generators, root commands
- [docs/tooling.md](docs/tooling.md) — Formatter, linter, and typechecker configuration
- [docs/submodules.md](docs/submodules.md) — `vendor/` submodules (`JoyAI-Video-Edit`, `seed-vc`) and sparse-checkout rules
- [docs/web.md](docs/web.md) — Next.js web app (`apps/web`)
- [docs/api.md](docs/api.md) — Effect v4 API server (`apps/api`)
- [docs/engine.md](docs/engine.md) — Python GPU inference server (`apps/engine-py`)
