// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import { OUTPUT_DIR, PORTS } from "../slot";

// UI state proofs need only Vite; no backend process, database or global tenant setup.
export default defineConfig({
  testDir: "..",
  testMatch: ["mock/*.spec.ts", "states/*.spec.ts"],
  outputDir: `${OUTPUT_DIR}-mock`,
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  timeout: 60_000,
  retries: 0,
  use: { browserName: "chromium", baseURL: `http://localhost:${PORTS.web}`, locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: { command: "npm run dev", url: `http://localhost:${PORTS.web}`, reuseExistingServer: false, env: { CONSOLE_WEB_PORT: String(PORTS.web) } },
});
