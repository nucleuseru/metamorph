A modern monorepo powered by [Turborepo](https://turbo.build/repo), [pnpm](https://pnpm.io/), and [TypeScript](https://www.typescriptlang.org/).

## Overview

This is a production-ready monorepo with pre-configured tooling for building full-stack applications. It includes shared ESLint configurations for various frameworks and environments, enabling consistent code quality across all packages.

## Project Structure

```
turborepo/
├── packages/          # Shared packages and configurations
│   └── eslint-config/ # ESLint configurations for different frameworks
└── apps/             # Application packages (to be added)
```

## Tech Stack

- **Build System**: [Turborepo](https://turbo.build/repo) v2.8.12 - High-performance build system for JavaScript/TypeScript monorepos
- **Package Manager**: [pnpm](https://pnpm.io/) v10.26.2 - Fast, disk space efficient package manager
- **Language**: [TypeScript](https://www.typescriptlang.org/) v5.9.3 - Typed JavaScript
- **Code Quality**:
  - ESLint v9.39.2 - Linting with flat config support
  - Prettier v3.8.1 - Code formatting with import organization and Tailwind CSS support

## Prerequisites

- Node.js >= 20
- pnpm 10.26.2 (automatically enforced via `packageManager` field)

## Getting Started

### Use as Template

To create a new project based on this template:

```bash
pnpm dlx create-turbo@latest --example https://github.com/nucleuseru/turborepo
```

### Installation

```bash
# Install dependencies
pnpm install
```

### Available Scripts

```bash
# Development
pnpm dev              # Run all apps in development mode

# Building
pnpm build            # Build all packages and apps

# Code Quality
pnpm lint             # Lint all packages
pnpm check-types      # Type-check all TypeScript code
pnpm format           # Format code with Prettier

# Maintenance
pnpm clean            # Remove node_modules and build artifacts
```

## Turborepo Configuration

The monorepo is configured with the following task pipeline (`turbo.json`):

### Build Task

- **Depends on**: Builds of workspace dependencies (`^build`)
- **Inputs**: Default Turbo inputs + `.env*` files
- **Outputs**: `.next/**`, `dist/**`, `.expo/**` (cache excluded for `.next/cache`)

### Development Task

- **Caching**: Disabled (always runs fresh)
- **Persistent**: Keeps running in watch mode

### Lint & Type Check Tasks

- **Depends on**: Respective tasks in workspace dependencies
- **Caching**: Enabled for faster subsequent runs

### Clean Task

- **Caching**: Disabled (always executes)

## TypeScript Configuration

The base TypeScript configuration (`tsconfig.base.json`) includes:

- **Target**: ESNext with modern module resolution
- **Strict Mode**: Enabled for maximum type safety
- **Module Resolution**: Bundler-compatible
- **Compiler Options**:
  - JSON module support
  - Isolated modules for better build performance
  - No emit (handled by build tools)
  - Incremental compilation

## Prettier Configuration

Code formatting is handled by Prettier with the following plugins:

- **prettier-plugin-organize-imports**: Automatically organizes imports
- **prettier-plugin-tailwindcss**: Sorts Tailwind CSS classes

## Workspace Structure

The monorepo uses pnpm workspaces with the following structure:

- `apps/*` - Application packages
- `packages/*` - Shared libraries and configurations

## Packages

### [@repo/eslint-config](./packages/eslint-config)

Comprehensive ESLint configurations for multiple frameworks and environments:

- Base configuration with TypeScript support
- Next.js with React Compiler support
- Expo/React Native
- NestJS
- Convex
- React (internal/library development)

See the [eslint-config README](./packages/eslint-config/README.md) for detailed usage.

## Development Workflow

1. **Add a new app**: Create a new directory in `apps/` with its own `package.json`
2. **Add a new package**: Create a new directory in `packages/` with its own `package.json`
3. **Install dependencies**: Run `pnpm install` at the root
4. **Development**: Use `pnpm dev` to start all apps in watch mode
5. **Build**: Use `pnpm build` to build all packages and apps

## Features

✅ **Fast builds** with Turborepo's caching and parallel execution  
✅ **Shared configurations** for ESLint across different frameworks  
✅ **Type-safe** with strict TypeScript configuration  
✅ **Modern tooling** with flat ESLint configs and latest standards  
✅ **Consistent formatting** with Prettier and auto-import organization  
✅ **Workspace protocol** for efficient local package linking

## Environment Variables

Global environment variables can be configured in `turbo.json` under `globalEnv`. Currently configured:

- `NODE_ENV` - Automatically available to all tasks

## License

ISC

---

Built with ❤️ using Turborepo
