// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
import { PORTS } from "./e2e/slot";

const origin = `https://localhost:${PORTS.web}`;
const backend = [config.webServer].flat()[0]!;

export default defineConfig({
  ...config,
  forbidOnly: !!process.env.CI,
  testMatch: ["**/perf/*.spec.ts"],
  grepInvert: /@clock/,
  workers: 1,
  projects: [{ name: "parallel", use: { baseURL: origin, ignoreHTTPSErrors: true } }],
  webServer: [
    { ...backend, env: { ...backend.env, CONSOLE_WEB_ORIGIN: origin } },
    {
      command: `node e2e/perf/proxy.ts http://127.0.0.1:${PORTS.backend} ${PORTS.web}`,
      wait: { stdout: /\[perf-proxy\] ready/ },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
