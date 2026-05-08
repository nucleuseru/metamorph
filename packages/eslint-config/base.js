import eslint from "@eslint/js";
import gitignore from "eslint-config-flat-gitignore";
import prettierPlugin from "eslint-plugin-prettier/recommended";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  gitignore({ cwd: process.cwd() }),
  globalIgnores(["eslint.config.mjs", "prettier.config.mjs"]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  prettierPlugin,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.mjs", "*.cjs"],
        },
        tsconfigRootDir: process.cwd(),
      },
    },
  },
);
