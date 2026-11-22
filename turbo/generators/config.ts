import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PlopTypes } from "@turbo/gen";

const KEBAB_NAME_REGEX = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

interface TurboAnswers extends PlopTypes.Answers {
  name?: string;
  turbo?: {
    paths?: {
      root?: string;
    };
  };
}

interface SyncAttempt {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function getRepoRoot(answers?: TurboAnswers): string {
  return answers?.turbo?.paths?.root ?? process.cwd();
}

function normalizeTsInput(raw: string): string {
  return raw.trim().replace(/^@metamorph\//, "");
}

function getTsPackageShortName(dirName: string): string {
  return dirName.endsWith("-ts") && dirName.length > 3 ? dirName.slice(0, -3) : dirName;
}

function normalizePyBaseName(raw: string): string {
  const trimmed = raw
    .trim()
    .replaceAll("_", "-")
    .replace(/^metamorph-/, "");
  return trimmed.endsWith("-py") ? trimmed.slice(0, -3) : trimmed;
}

function findExistingTsPackageByName(rootDir: string, packageName: string): string | undefined {
  const packagesDir = path.join(rootDir, "packages");
  if (!fs.existsSync(packagesDir)) {
    return undefined;
  }

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgJsonPath = path.join(packagesDir, entry.name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { name?: string };
      if (parsed.name === packageName) {
        return `packages/${entry.name}`;
      }
    } catch {
      // Ignore malformed package.json files
    }
  }
  return undefined;
}

function validateBaseName(
  normalized: string,
  example: string,
  rootDir: string,
  dirName: string,
): true | string {
  if (!normalized) {
    return "Package name is required.";
  }
  if (!KEBAB_NAME_REGEX.test(normalized)) {
    return `Use lowercase kebab-case starting with a letter (e.g. ${example}).`;
  }
  if (fs.existsSync(path.join(rootDir, "packages", dirName))) {
    return `Directory 'packages/${dirName}' already exists.`;
  }
  return true;
}

function validateTsPackageName(raw: string, rootDir: string): true | string {
  const dirName = normalizeTsInput(raw);
  if (dirName.endsWith("-py")) {
    return "TypeScript packages must not end with '-py' (reserved for Python workspaces).";
  }
  const baseResult = validateBaseName(dirName, "'audio' or 'video-utils'", rootDir, dirName);
  if (baseResult !== true) {
    return baseResult;
  }
  const fullPackageName = `@metamorph/${getTsPackageShortName(dirName)}`;
  const existing = findExistingTsPackageByName(rootDir, fullPackageName);
  if (existing) {
    return `Package '${fullPackageName}' already exists at '${existing}'.`;
  }
  return true;
}

function validatePyPackageName(raw: string, rootDir: string): true | string {
  const baseName = normalizePyBaseName(raw);
  return validateBaseName(baseName, "'audio' or 'voice-clone'", rootDir, `${baseName}-py`);
}

function assertValid(result: true | string): void {
  if (result !== true) {
    throw new Error(result);
  }
}

function runWorkspaceSync(attempts: SyncAttempt[], rootDir: string, fallbackHint: string): string {
  for (const { command, args, env } of attempts) {
    try {
      execFileSync(command, args, {
        cwd: rootDir,
        stdio: "inherit",
        env: env ? { ...process.env, ...env } : process.env,
      });
      return `Ran '${command} ${args.join(" ")}'`;
    } catch {
      // Try next sync strategy
    }
  }
  return `Warning: automatic sync skipped (${fallbackHint}).`;
}

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator("ts-package", {
    description: "Add a new TypeScript package (@metamorph/*) under packages/",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Package name (e.g. audio or audio-ts):",
        validate: (input: string, answers?: TurboAnswers) =>
          validateTsPackageName(input, getRepoRoot(answers)),
      },
    ],
    actions: (answers?: TurboAnswers) => {
      const rootDir = getRepoRoot(answers);
      const rawName = answers?.name ?? "";
      assertValid(validateTsPackageName(rawName, rootDir));

      const dirName = normalizeTsInput(rawName);
      const packageShortName = getTsPackageShortName(dirName);
      const data = { dirName, packageShortName };

      return [
        {
          type: "add",
          path: "packages/{{dirName}}/package.json",
          templateFile: "templates/ts-package/package.json.hbs",
          data,
        },
        {
          type: "add",
          path: "packages/{{dirName}}/tsconfig.json",
          templateFile: "templates/ts-package/tsconfig.json.hbs",
          data,
        },
        {
          type: "add",
          path: "packages/{{dirName}}/src/index.ts",
          templateFile: "templates/ts-package/src/index.ts.hbs",
          data,
        },
        () =>
          runWorkspaceSync(
            [{ command: "pnpm", args: ["install", "--offline"] }],
            rootDir,
            "run 'pnpm install' to link the workspace package",
          ),
      ];
    },
  });

  plop.setGenerator("py-package", {
    description: "Add a new Python package (*-py) under packages/",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Package name (e.g. audio or audio-py):",
        validate: (input: string, answers?: TurboAnswers) =>
          validatePyPackageName(input, getRepoRoot(answers)),
      },
    ],
    actions: (answers?: TurboAnswers) => {
      const rootDir = getRepoRoot(answers);
      const rawName = answers?.name ?? "";
      assertValid(validatePyPackageName(rawName, rootDir));

      const baseName = normalizePyBaseName(rawName);
      const dirName = `${baseName}-py`;
      const distName = `metamorph-${baseName}`;
      const moduleName = `metamorph_${baseName.replaceAll("-", "_")}`;
      const data = { baseName, dirName, distName, moduleName };

      return [
        {
          type: "add",
          path: "packages/{{dirName}}/pyproject.toml",
          templateFile: "templates/py-package/pyproject.toml.hbs",
          data,
        },
        {
          type: "add",
          path: "packages/{{dirName}}/src/{{moduleName}}/__init__.py",
          templateFile: "templates/py-package/src/__init__.py.hbs",
          data,
        },
        () =>
          runWorkspaceSync(
            [
              { command: "uv", args: ["sync", "--offline"] },
              { command: "uv", args: ["sync"] },
            ],
            rootDir,
            "run 'uv sync' to register the workspace member",
          ),
      ];
    },
  });
}
