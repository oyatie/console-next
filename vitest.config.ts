import { defineConfig } from "vitest/config";
export default defineConfig({ cacheDir: ".cache/vitest", test: { include: ["apps/*/src/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.{ts,tsx}", "scripts/*.test.ts"] } });
