import { defineConfig } from "eslint/config";
import globals from "globals";
import baseConfigs from "./base.js";

export default defineConfig(
  baseConfigs,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: "commonjs",
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.mjs", "*.cjs"],
        },
        tsconfigRootDir: process.cwd(),
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
);
