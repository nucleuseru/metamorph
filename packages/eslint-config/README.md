# @repo/eslint-config

Comprehensive ESLint configurations for modern JavaScript/TypeScript projects across multiple frameworks and environments.

## Overview

This package provides pre-configured ESLint setups using the new [flat config format](https://eslint.org/docs/latest/use/configure/configuration-files-new) (ESLint v9+). Each configuration is optimized for specific frameworks and use cases, extending a common base configuration with strict TypeScript checking and Prettier integration.

## Available Configurations

| Configuration    | Description                                   | Use Case                                 |
| ---------------- | --------------------------------------------- | ---------------------------------------- |
| `base`           | Base configuration with TypeScript + Prettier | Backend services, CLIs, shared utilities |
| `next`           | Next.js with Turbo and React Compiler         | Next.js applications                     |
| `expo`           | Expo/React Native with Turbo                  | React Native mobile apps                 |
| `nest`           | NestJS with Turbo                             | NestJS backend applications              |
| `convex`         | Convex backend functions                      | Convex serverless functions              |
| `react-internal` | React library development                     | Internal React components/libraries      |

## Installation

This package is designed for use within the monorepo and is automatically available to workspace packages.

### For workspace packages:

Add to your `package.json`:

```json
{
  "devDependencies": {
    "@repo/eslint-config": "workspace:*"
  }
}
```

## Usage

### Base Configuration

Ideal for backend services, Node.js applications, and shared utilities.

**Features:**

- ESLint recommended rules
- TypeScript strict + stylistic type checking
- Prettier integration
- Gitignore-aware (respects `.gitignore`)
- Project service for type-aware linting

**eslint.config.mjs:**

```javascript
import config from "@repo/eslint-config/base";

export default config;
```

### Next.js Configuration

Optimized for Next.js applications with Web Vitals and React Compiler support.

**Features:**

- All base configuration features
- Next.js core web vitals rules
- Next.js TypeScript rules
- Turborepo optimization rules
- React Compiler recommended rules

**eslint.config.mjs:**

```javascript
import config from "@repo/eslint-config/next";

export default config;
```

### Expo Configuration

For Expo/React Native mobile applications.

**Features:**

- All base configuration features
- Expo-specific rules and utilities
- React and React Hooks rules
- React Compiler support
- Turborepo optimization
- Disabled `no-require-imports` for React Native compatibility

**eslint.config.mjs:**

```javascript
import config from "@repo/eslint-config/expo";

export default config;
```

### NestJS Configuration

Minimal configuration for NestJS backend applications.

**Features:**

- All base configuration features
- Turborepo optimization rules

**eslint.config.mjs:**

```javascript
import config from "@repo/eslint-config/nest";

export default config;
```

### Convex Configuration

For Convex serverless backend functions.

**Features:**

- All base configuration features
- Convex-specific linting rules
- Convex best practices

**eslint.config.mjs:**

```javascript
import config from "@repo/eslint-config/convex";

export default config;
```

### React Internal Configuration

For developing internal React libraries and component packages.

**Features:**

- All base configuration features
- React recommended rules
- React Hooks latest rules
- React Compiler support
- Automatic React version detection
- Modern React (no JSX pragma required)

**eslint.config.mjs:**

```javascript
import config from "@repo/eslint-config/react-internal";

export default config;
```

## Configuration Details

### Base Configuration Stack

All configurations extend the base setup which includes:

1. **Gitignore Integration** - Automatically respects `.gitignore` patterns
2. **Global Ignores** - Excludes `eslint.config.mjs` from linting
3. **ESLint Recommended** - Core ESLint rules
4. **TypeScript ESLint** - Strict and stylistic type-checked rules
5. **Prettier Integration** - Ensures Prettier and ESLint play nicely together
6. **Project Service** - Type-aware linting using your `tsconfig.json`

### Framework-Specific Additions

#### Next.js (`next.js`)

- `eslint-config-next/core-web-vitals`
- `eslint-config-next/typescript`
- `eslint-plugin-react-compiler`

#### Expo (`expo.js`)

- `eslint-config-expo/flat/utils/expo`
- React internal rules
- Allows `require()` imports for React Native

#### React Internal (`react-internal.js`)

- `eslint-plugin-react` (flat recommended)
- `eslint-plugin-react-hooks` (recommended-latest)
- `eslint-plugin-react-compiler`
- Disables legacy JSX pragma rules

#### Convex (`convex.js`)

- `@convex-dev/eslint-plugin` (recommended)

## Dependencies

### Core Dependencies

- `@eslint/js` - ESLint core rules
- `typescript-eslint` - TypeScript linting
- `eslint-plugin-prettier` - Prettier integration
- `eslint-config-prettier` - Disables conflicting rules
- `eslint-config-flat-gitignore` - Gitignore support

### Framework-Specific

- `eslint-config-next` - Next.js rules
- `eslint-config-expo` - Expo/React Native rules
- `eslint-plugin-react` - React rules
- `eslint-plugin-react-hooks` - React Hooks rules
- `eslint-plugin-react-compiler` - React Compiler rules
- `@convex-dev/eslint-plugin` - Convex rules

## Extending Configurations

You can extend any configuration with custom rules:

```javascript
import config from "@repo/eslint-config/base";
import { defineConfig } from "eslint/config";

export default defineConfig(...config, {
  rules: {
    // Your custom rules
    "no-console": "warn",
  },
});
```

## Type-Aware Linting

All configurations use TypeScript's project service for type-aware linting. This provides more accurate linting but requires:

1. A valid `tsconfig.json` in your project
2. Proper `include`/`exclude` patterns in your tsconfig
3. The linting to run from your project's root directory

The configuration automatically uses `process.cwd()` to find your project's TypeScript configuration.

## Best Practices

1. **Use the specific config for your framework** - Don't use `base` when a framework-specific config exists
2. **Keep your tsconfig.json up to date** - Type-aware rules depend on it
3. **Run linting from project root** - Ensures correct tsconfig resolution
4. **Use with Prettier** - All configs include Prettier integration
5. **Leverage Turborepo caching** - Configs with Turbo optimize for monorepo performance

## Troubleshooting

### Type-aware linting is slow

- Ensure your `tsconfig.json` doesn't include unnecessary files
- Use `skipLibCheck: true` in your tsconfig
- Leverage Turborepo's caching for faster subsequent runs

### Rules conflicting with Prettier

- All configs include `eslint-plugin-prettier/recommended` which should prevent conflicts
- Run `pnpm format` after linting to ensure consistency

### Config not found

- Ensure you're using the correct export path (e.g., `@repo/eslint-config/base`)
- Check that the package is installed: `pnpm install`

## Version Compatibility

- **ESLint**: v9+ (flat config format)
- **TypeScript**: v5.9+
- **Node.js**: v20+

## License

ISC

---

Part of the [Turborepo Template](../../README.md) monorepo
