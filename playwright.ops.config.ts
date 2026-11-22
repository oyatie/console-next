// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import { e2eBrowser } from "./e2e/browser";
import { AGENT, OUTPUT_DIR } from "./e2e/slot";

const slot = Number(process.env.E2E_SLOT ?? 0);
const opsPort = (AGENT ? 5185 : 5174) + slot;
const dist = `../../.cache/ops-dist-${opsPort}`;
const origin = `http://localhost:${opsPort}`;

export default defineConfig({
  testDir: "e2e/ops",
  outputDir: `${OUTPUT_DIR}-ops`,
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? (process.env.CI ? 2 : 4)),
  reporter: process.env.CI ? "dot" : "list",
  timeout: 45_000,
  expect: { timeout: 5_000 },
  retries: 0,
  use: {
    browserName: e2eBrowser(),
    baseURL: origin,
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build -w @console/ops -- --outDir ${dist} --emptyOutDir && npm run preview -w @console/ops -- --outDir ${dist} --port ${opsPort} --strictPort`,
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
