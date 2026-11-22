# AGENTS.md

`metamorph` is a TypeScript and Python monorepo for real-time body swapping, voice cloning, and video editing.

## Repository Layout

- `apps/` — Applications (TypeScript apps and `*-py` Python apps)
- `packages/` — Shared libraries (`@metamorph/*` TypeScript packages, `*-py` Python packages)
- `vendor/` — Git submodules (`JoyAI-Video-Edit`, `seed-vc`) managed with sparse-checkout
- `docs/` — Detailed project documentation

## Non-Negotiable Rules

1. **Package managers**: Use `pnpm` for Node/TypeScript and `uv` for Python. Never use `npm`, `yarn`, `pip`, or `poetry`.
2. **Python workspace naming**: Any Python app or package under `apps/` or `packages/` **must** end with `-py` (e.g., `packages/shared-py`, `apps/engine-py`) so `uv` (`[tool.uv.workspace]`) discovers it without colliding with TypeScript directories.
3. **Speed-first tooling**:
   - TypeScript/JS: `oxfmt` (format), `oxlint` (lint), `tsc` via `turbo` (typecheck)
   - Python: `ruff` (format + lint), `ty` (typecheck)
4. **Vendor submodules**: Do not format, lint, or directly modify `vendor/` unless explicitly tasked with patching upstream code. Both `vendor/JoyAI-Video-Edit` and `vendor/seed-vc` use `git sparse-checkout` to omit training/eval/assets.
5. **Verify before finishing**: Run `pnpm format:check && pnpm lint && pnpm typecheck` after code or config changes.

## Documentation

Read only the relevant doc for your task:

- [docs/monorepo.md](docs/monorepo.md) — Workspace layout, Turborepo pipelines, adding TS/Python packages, root commands
- [docs/tooling.md](docs/tooling.md) — Formatter, linter, and typechecker configuration and usage
- [docs/submodules.md](docs/submodules.md) — `JoyAI-Video-Edit` and `seed-vc` submodule layout, sparse-checkout rules, and boundaries
