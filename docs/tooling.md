# Formatting, Linting & Typechecking

This repository prioritizes Rust/native tooling over legacy JS/Python tools for fast local feedback.

## TypeScript / JavaScript / Config / Markdown

| Task      | Tool         | Config               | Command                            |
| :-------- | :----------- | :------------------- | :--------------------------------- |
| Format    | `oxfmt`      | `.oxfmtrc.json`      | `pnpm format:ts` / `oxfmt --check` |
| Lint      | `oxlint`     | `.oxlintrc.json`     | `pnpm lint:ts`                     |
| Typecheck | `tsc` (TS 7) | `tsconfig.base.json` | `pnpm typecheck:ts`                |

- `oxlint` enables `typescript`, `unicorn`, and `oxc` plugins with `correctness: "error"` and `suspicious: "warn"`.
- Both `.oxlintrc.json` and `.oxfmtrc.json` ignore `.venv/**`, `dist/**`, `build/**`, `.turbo/**`, `node_modules/**`, `vendor/**`, and `.agents/**` (`**/.agents/**`).

## Python

| Task      | Tool          | Config                                  | Command             |
| :-------- | :------------ | :-------------------------------------- | :------------------ |
| Format    | `ruff format` | `pyproject.toml` (`[tool.ruff.format]`) | `pnpm format:py`    |
| Lint      | `ruff check`  | `pyproject.toml` (`[tool.ruff.lint]`)   | `pnpm lint:py`      |
| Typecheck | `ty check`    | `pyproject.toml` (`[tool.ty.src]`)      | `pnpm typecheck:py` |

- `ruff` targets `py312` with `line-length = 100` and enables `E`, `W`, `F`, `I`, `UP`, `B`, `SIM`, `RUF`.
- Both `ruff` (`extend-exclude`) and `ty` (`exclude`) skip `vendor` and `**/.agents`.
