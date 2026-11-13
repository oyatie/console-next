// SPDX-License-Identifier: LicenseRef-Proprietary
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { e2eBrowser } from "../../../../../../e2e/browser";

const repo = path.resolve(import.meta.dirname, "../../../../../..");
const port = Number(process.env.CONSOLE_WEB_PORT ?? 58742);
const origin = `http://127.0.0.1:${port}`;

// Component journeys use the dev gallery and cached query fixtures, without a database.
export default defineConfig({
  testDir: ".",
  testMatch: ["grid-table.spec.ts", "grid-table-focus.spec.ts", "grid-table-paste.spec.ts"],
  outputDir: path.join(repo, "node_modules/.cache/grid-playwright"),
  forbidOnly: !!process.env.CI,
  // Both specs must share a worker to cover per-test locale and error-guard setup.
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { baseURL: origin, browserName: e2eBrowser(), viewport: { width: 1280, height: 800 }, locale: "en-US", timezoneId: "Asia/Seoul" },
  webServer: {
    command: "npm run dev -w @console/web -- --host 127.0.0.1",
    cwd: repo,
    url: origin,
    env: { CONSOLE_WEB_PORT: String(port) },
    reuseExistingServer: false,
  },
});
