import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactCompiler from "eslint-plugin-react-compiler";
import { defineConfig } from "eslint/config";
import baseConfigs from "./base.js";

export default defineConfig(
  baseConfigs,
  ...nextVitals,
  ...nextTs,
  reactCompiler.configs.recommended,
  {
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
);
