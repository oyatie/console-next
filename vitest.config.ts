import { defineConfig } from "vitest/config";
// Browser-backed tests (Playwright in Vitest) run several real waits per test; 5 s timed out on loaded CI runners.
export default defineConfig({ cacheDir: ".cache/vitest", test: { testTimeout: 15_000, include: ["apps/*/src/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.{ts,tsx}", "scripts/*.test.ts"] } });
