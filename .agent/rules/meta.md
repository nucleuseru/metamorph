---
trigger: always_on
---

# Porject Meta

This project uses the following technologies and tools. All contributions and operations should adhere to their patterns and conventions:

- **Package Manager**: pnpm
- **Monorepo Management**: Turborepo
- **Runtime Environment**: Node.js

## Development Guidelines

1. **Package Management**: Always use `pnpm` for installing dependencies and running scripts. Avoid using `npm`, `npx`, `yarn` at all cost.
2. **Task Execution**: Use `turbo` commands (e.g., `pnpm turbo build`, `pnpm turbo lint`) to run tasks across the monorepo efficiently.
3. **Monorepo Structure**: The project is organized into `apps/` and `packages/`. Follow existing patterns when adding new components or services.
4. **Package generation**: Use `pnpm turbo gen package --args [name]` to create a new shared package in the monorepo.
