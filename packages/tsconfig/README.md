# @repo/tsconfig

Shared TypeScript configurations for modern JavaScript/TypeScript projects within the monorepo.

## Overview

This package provides a centralized location for TypeScript configurations, ensuring consistency across all packages and applications in the monorepo. By extending these shared configurations, you can maintain a unified set of compiler options while allowing for project-specific overrides when necessary.

## Available Configurations

| Configuration | Description                                    | Use Case                                |
| :------------ | :--------------------------------------------- | :-------------------------------------- |
| `base.json`   | Modern base configuration with strict checking | All TypeScript projects in the monorepo |

## Installation

This package is designed for use within the monorepo and is automatically available to workspace packages.

### For workspace packages:

Add it to your `package.json`:

```json
{
  "devDependencies": {
    "@repo/tsconfig": "workspace:*"
  }
}
```

## Usage

Extend the shared configuration in your project's `tsconfig.json`:

```json
{
  "extends": "@repo/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["node_modules"]
}
```

## Configuration Details (`base.json`)

The base configuration is optimized for modern development with the following key settings:

- **Target/Module**: `ESNext` for modern JavaScript features.
- **Module Resolution**: `bundler` for compatibility with modern build tools.
- **Strict Mode**: `true` (includes all strict type-checking options).
- **Type Checking**:
  - `noUncheckedIndexedAccess`: Ensures safe access to indexed types.
  - `skipLibCheck`: Skips type checking of declaration files for faster builds.
- **Interoperability**:
  - `esModuleInterop`: Enables emit interoperability between CommonJS and ES Modules.
  - `allowSyntheticDefaultImports`: Allows default imports from modules with no default export.
- **Project Structure**:
  - `isolatedModules`: Ensures each file can be safely transpiled without relying on other imports.
  - `incremental`: Enables incremental compilation for faster subsequent builds.

## Best Practices

1. **Extend, don't copy**: Always extend the `base.json` to benefit from centralized updates.
2. **Incremental Builds**: The `incremental: true` setting is enabled by default to improve build performance.
3. **Implicit Overrides**: If you need to change a specific setting (e.g., `target`), override it in your local `tsconfig.json`.
4. **Consistency**: Use the same base for both apps and internal packages to ensure compatible type checking.

## License

ISC

---

Part of the [Turborepo Template](../../README.md) monorepo
