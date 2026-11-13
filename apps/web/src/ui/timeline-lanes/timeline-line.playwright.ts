// SPDX-License-Identifier: LicenseRef-Proprietary
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { e2eBrowser } from "../../../../../e2e/browser";

const repo = path.resolve(import.meta.dirname, "../../../../../");
const port = Number(process.env.CONSOLE_WEB_PORT ?? 58741);
const origin = `http://127.0.0.1:${port}`;
const browserName = e2eBrowser();

// These are component journeys in the unauthenticated gallery; they use no database or record fixtures.
export default defineConfig({
  testDir: ".",
  testMatch: "timeline-line.spec.ts",
  outputDir: path.join(repo, "test-results/timeline", browserName),
  forbidOnly: !!process.env.CI,
  workers: 2,
  retries: 0,
  reporter: "line",
  projects: [{ name: browserName, use: { browserName } }],
  use: { baseURL: origin, locale: "ko-KR", timezoneId: "Asia/Seoul", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -w @console/web -- --host 127.0.0.1",
    cwd: repo,
    url: origin,
    env: { CONSOLE_WEB_PORT: String(port) },
    reuseExistingServer: false,
  },
});
