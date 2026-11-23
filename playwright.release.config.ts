// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import { CACHE_DIR, COMPOSE_PROJECT, PORTS } from "./e2e/slot";

const origin = `http://localhost:${PORTS.backend}`;
const stackTimeout = 300_000;
// The cold-start passkey belongs to this project's disposable database.
process.env.E2E_CACHE_DIR = `${CACHE_DIR}-release`;

export default defineConfig({
  testDir: "e2e/release",
  grep: /@release/,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  timeout: 180_000,
  use: { baseURL: origin, locale: "ko-KR", timezoneId: "Asia/Seoul", trace: "retain-on-failure" },
  webServer: {
    command: "node scripts/backend-dev.mjs --release-image --reset",
    // Let the launcher reclaim its named container before checking readiness.
    wait: { stdout: /\[backend\] ready/ },
    timeout: stackTimeout,
    gracefulShutdown: { signal: "SIGTERM", timeout: stackTimeout },
    env: { CONSOLE_WEB_ORIGIN: origin, CONSOLE_DEV_PROJECT: `${COMPOSE_PROJECT}-release` },
  },
});
