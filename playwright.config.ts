import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { LIFECYCLE_TODAY_FILE } from "./e2e/clock";
import { AGENT, CACHE_DIR, COMPOSE_PROJECT, OUTPUT_DIR, PORTS } from "./e2e/slot";

// Runs against the real backend from an EMPTY database (no fixtures): every row is created
// through the UI. WebAuthn RP id is `localhost`, so the app is always addressed as localhost.
//
// E2E_SERVED=1 is the production shape: the Rust backend serves the built SPA itself
// (CONSOLE_WEB_DIST) on one origin; otherwise Vite serves the app and proxies /api.
const served = process.env.E2E_SERVED === "1";
// E2E_REUSE=1 reuses a dev/visual stack; served release proofs always start with an empty database.
const reuse = process.env.E2E_REUSE === "1" && !served;
// E2E_XBROWSER=1 runs Firefox instead of Chromium (the INTEG gate's second leg; see projects).
const xbrowser = process.env.E2E_XBROWSER === "1";
const testIgnore = /live-renew\.server-expiry\.spec\.ts$/;
const origin = served ? `http://localhost:${PORTS.backend}` : `http://localhost:${PORTS.web}`;
const backendEnv = {
  // The public monorepo carries backend/ beside apps/; the private checkouts are siblings.
  CONSOLE_APP_BIN:
    process.env.CONSOLE_APP_BIN ??
    `${existsSync("backend/Cargo.toml") ? "." : "../frontend/backend-mvp"}/backend/target/debug/console-app`,
  CONSOLE_WEB_ORIGIN: origin,
  // The slot's own stack (e2e/slot.ts): ports, compose project and cache never overlap another slot's.
  CONSOLE_DEV_PROJECT: COMPOSE_PROJECT,
  CONSOLE_DEV_PG_PORT: String(PORTS.pg),
  CONSOLE_DEV_S3_PORT: String(PORTS.s3),
  CONSOLE_DEV_OTEL_PORT: String(PORTS.otel),
  CONSOLE_DEV_BACKEND_PORT: String(PORTS.backend),
  CONSOLE_MAILPIT_SMTP_PORT: String(PORTS.smtp),
  CONSOLE_MAILPIT_UI_PORT: String(PORTS.mailUi),
  E2E_CACHE_DIR: CACHE_DIR,
  // The dev/test switch for applying scheduled actions on a date a test chooses (see e2e/clock.ts).
  CONSOLE_DEV_LIFECYCLE_TODAY_FILE: LIFECYCLE_TODAY_FILE,
  // The production trusted-proxy path: the backend honours X-Forwarded-For from its one local hop (Vite's
  // proxy, or the browser on localhost), so each test context has its own client IP (e2e/flows.ts newContext).
  CONSOLE_TRUSTED_PROXY_COUNT: "1",
  CONSOLE_TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
  // The run's throwaway database commits without waiting on the VM's disk (scripts/backend-dev.mjs).
  CONSOLE_DEV_ASYNC_COMMIT: "1",
  CONSOLE_EMAIL_STUB_MODE: "e2e",
  // Paired release proofs may serve the shipped FE build while using this branch's test harness.
  ...(served
    ? { CONSOLE_WEB_DIST: path.resolve(process.env.CONSOLE_WEB_DIST ?? "apps/web/dist") }
    : {}),
};

export default defineConfig({
  testDir: "e2e",
  outputDir: OUTPUT_DIR,
  globalSetup: "./e2e/global-setup.ts",
  timeout: 120_000,
  // Every test builds its own tenant through the product, so tests run side by side (one backend, one Vite).
  fullyParallel: true,
  // The short-TTL server-expiry journey runs in its own profile so other E2E sessions stay at 15 minutes.
  testIgnore,
  workers: Number(process.env.E2E_WORKERS ?? (process.env.CI ? 2 : 4)),
  // Every run records its passing tests' durations, which scripts/e2e-slot.mjs plans shards from. A sharded
  // e2e:agent run passes the caller's --reporter as E2E_REPORTER and collects one blob per job to merge.
  reporter: [
    ...(process.env.E2E_REPORTER ?? (process.env.CI ? "dot" : "list")).split(",").map((name) => [name] as const),
    ["./e2e/timings-reporter.mjs"],
    ...(process.env.PLAYWRIGHT_BLOB_OUTPUT_FILE ? [["blob"] as const] : []),
  ],
  // E2E_XBROWSER=1 is the Firefox leg alone: every spec creates its tenants under fixed identifiers, so two
  // engines cannot share one database. The clock specs and the gallery baselines stay Chromium-only.
  projects: xbrowser
    ? [{ name: "firefox", use: { browserName: "firefox" }, grepInvert: /@clock/, testIgnore: [testIgnore, /visual\.spec\.ts/] }]
    : [
        { name: "parallel", grepInvert: /@clock/ },
        // Date-moving tests (e2e/clock.ts) share the backend's one apply date: alone, one at a time, after the rest.
        { name: "clock", grep: /@clock/, workers: 1, dependencies: ["parallel"] },
      ],
  // Both projects share the visual baselines (no project name in the file name).
  snapshotPathTemplate: "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}",
  // A flaky failure stays visible; quarantine requires an owner and expiry in CI config.
  retries: 0,
  failOnFlakyTests: !!process.env.CI,
  use: {
    baseURL: origin,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    trace: { mode: "retain-on-failure", screenshots: false },
  },
  webServer: [
    {
      // E2E_PREBUILT=1: a sharded run built apps/web/dist once, so its jobs do not build into it side by side.
      command: served
        ? `${process.env.E2E_PREBUILT === "1" ? "" : "npm run build && "}node scripts/backend-dev.mjs --reset`
        : `node scripts/backend-dev.mjs${reuse ? "" : " --reset"}`,
      url: `http://127.0.0.1:${PORTS.backend}/readyz`,
      timeout: 300_000,
      reuseExistingServer: reuse,
      env: backendEnv,
      // E2E_BACKEND_LOG=1: the backend's log (RUST_LOG, default info) in this run's output, as [WebServer] lines.
      stdout: process.env.E2E_BACKEND_LOG === "1" ? "pipe" : "ignore",
    },
    ...(served
      ? []
      : [{ command: "npm run dev", url: origin, reuseExistingServer: !AGENT, env: { CONSOLE_WEB_PORT: String(PORTS.web), CONSOLE_BACKEND: `http://127.0.0.1:${PORTS.backend}` } }]),
  ],
});
