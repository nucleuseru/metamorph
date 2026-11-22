# Web App (`apps/web`)

`@metamorph/web` is the Next.js frontend application in `apps/web`.

## Stack & Configuration

- **Framework**: Next.js `16.4.6` using the App Router under `src/app/` (`next.config.ts`)
- **React**: `19.3.0`
- **Styling**: Tailwind CSS `4.3.3` configured with `@tailwindcss/turbopack` in `next.config.ts` and `src/app/globals.css`
- **Next.js Features**: `cacheComponents: true` and `partialPrefetching: true` enabled in `next.config.ts`
- **TypeScript**: `apps/web/tsconfig.json` extends `../../tsconfig.base.json` with `@/*` mapped to `./src/*`

## Tooling & Monorepo Integration

- **Linting & Formatting**: Handled at the monorepo root by `oxlint` and `oxfmt` (see [docs/tooling.md](tooling.md)). Do not add ESLint or Prettier configs inside `apps/web`.
- **Ignored Build Artifacts**: `.next/**` and `apps/web/.next/**` are excluded from `oxlint` and `oxfmt` in the root config files, and `.next/**` (excluding `.next/cache/**`) is listed in `turbo.json` `build.outputs`.
- **Dependencies**: Managed with `pnpm` in the root workspace (`pnpm --filter @metamorph/web <cmd>` or `pnpm install` at the repo root).

## Commands

| Command                                            | Action                             |
| :------------------------------------------------- | :--------------------------------- |
| `pnpm --filter @metamorph/web dev`                 | Start the Next.js dev server       |
| `pnpm --filter @metamorph/web build`               | Build the production app           |
| `pnpm --filter @metamorph/web start`               | Start the production server        |
| `pnpm --filter @metamorph/web typecheck`           | Run `next typegen && tsc --noEmit` |
| `pnpm format:check && pnpm lint && pnpm typecheck` | Full repo verification from root   |

## Next.js Reference Docs

Because Next.js 16 includes breaking changes relative to older versions, read the bundled version-specific documentation in `apps/web/node_modules/next/dist/docs/` (starting at `apps/web/node_modules/next/dist/docs/index.md`) before implementing App Router, caching, or routing features.
