import path from "node:path";
import { defineConfig } from "@playwright/test";

const repo = path.resolve(import.meta.dirname, "../../../../../");
const port = Number(process.env.CONSOLE_WEB_PORT ?? 58741);
const origin = `http://127.0.0.1:${port}`;

// These are component journeys in the unauthenticated gallery; they use no database or record fixtures.
export default defineConfig({
  testDir: ".",
  testMatch: "timeline-line.spec.ts",
  outputDir: path.join(repo, "node_modules/.cache/ledger-playwright"),
  workers: 2,
  retries: 0,
  reporter: "line",
  use: { baseURL: origin, browserName: "chromium", locale: "ko-KR", timezoneId: "Asia/Seoul" },
  webServer: {
    command: "npm run dev -w @console/web -- --host 127.0.0.1",
    cwd: repo,
    url: origin,
    env: { CONSOLE_WEB_PORT: String(port) },
    reuseExistingServer: false,
  },
});
