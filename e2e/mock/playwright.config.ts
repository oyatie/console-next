// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";
import { e2eBrowser } from "../browser";
import { OUTPUT_DIR, PORTS } from "../slot";
import timings from "./timings.json" with { type: "json" };
import { BASELINE, experienceState } from "../experience";

const dist = `../../.cache/states-${PORTS.web}`;
const origin = `http://localhost:${PORTS.web}`;
const assertionTimeout = 5_000;

// Prebuild lazy chunks once so state assertions never wait on Vite's dev transforms.
export default defineConfig({
  metadata: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() },
  testDir: "..",
  testMatch: ["mock/*.spec.ts", "states/*.spec.ts", "layout/layout.spec.ts"],
  outputDir: `${OUTPUT_DIR}-mock`,
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? timings.workers),
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ? [["dot"], ["json"]] : "list",
  timeout: 60_000,
  expect: { timeout: assertionTimeout },
  retries: 0,
  use: { browserName: e2eBrowser(), baseURL: origin, locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block", trace: "retain-on-failure",
    storageState: experienceState(process.env.E2E_EXPERIENCE) },
  // Behaviour follows the shipped default (or E2E_EXPERIENCE); only Classic-look pins name Classic. A test list of bare
  // spec paths runs both, and each test belongs to exactly one.
  projects: [
    { name: "default", grepInvert: BASELINE },
    { name: "baseline", grep: BASELINE, use: { storageState: experienceState("baseline") } },
  ],
  webServer: { command: `VITE_REVIEW_STATE_ROUTES=1 npm run build -w @console/web -- --mode test --outDir ${dist} --emptyOutDir && npm run preview -w @console/web -- --outDir ${dist} --port ${PORTS.web} --strictPort`, url: `http://localhost:${PORTS.web}`, reuseExistingServer: false },
});
