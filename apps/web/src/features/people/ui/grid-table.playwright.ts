// SPDX-License-Identifier: LicenseRef-Proprietary
import path from "node:path";
import { defineConfig } from "@playwright/test";

const repo = path.resolve(import.meta.dirname, "../../../../../..");
const port = Number(process.env.CONSOLE_WEB_PORT ?? 58742);
const origin = `http://127.0.0.1:${port}`;

// Component journeys use the dev gallery and cached query fixtures, without a database.
export default defineConfig({
  testDir: ".",
  testMatch: "grid-table.spec.ts",
  outputDir: path.join(repo, "node_modules/.cache/grid-playwright"),
  workers: 2,
  retries: 0,
  reporter: "line",
  use: { baseURL: origin, browserName: "chromium", viewport: { width: 1280, height: 800 }, locale: "en-US", timezoneId: "Asia/Seoul" },
  webServer: {
    command: "npm run dev -w @console/web -- --host 127.0.0.1",
    cwd: repo,
    url: origin,
    env: { CONSOLE_WEB_PORT: String(port) },
    reuseExistingServer: false,
  },
});
