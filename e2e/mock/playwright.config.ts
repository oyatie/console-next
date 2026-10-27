// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import { OUTPUT_DIR, PORTS } from "../slot";

const dist = `../../.cache/states-${PORTS.web}`;

// Prebuild lazy chunks once so state assertions never wait on Vite's dev transforms.
export default defineConfig({
  testDir: "..",
  testMatch: ["mock/*.spec.ts", "states/*.spec.ts", "layout/layout.spec.ts"],
  outputDir: `${OUTPUT_DIR}-mock`,
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  timeout: 60_000,
  retries: 0,
  use: { browserName: "chromium", baseURL: `http://localhost:${PORTS.web}`, locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: { command: `npm run build -w @console/web -- --mode test --outDir ${dist} --emptyOutDir && npm run preview -w @console/web -- --outDir ${dist} --port ${PORTS.web} --strictPort`, url: `http://localhost:${PORTS.web}`, reuseExistingServer: false },
});
