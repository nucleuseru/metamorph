import convexPlugin from "@convex-dev/eslint-plugin";
import { defineConfig } from "eslint/config";
import baseConfigs from "./base.js";

export default defineConfig(baseConfigs, convexPlugin.configs.recommended);
