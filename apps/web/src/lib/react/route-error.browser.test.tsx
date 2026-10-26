// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./route-error.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let status = 503;
let network = false;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/vite-route-error-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/lib/react/route-error.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/route-error-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Route error test</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
  await page.route("**/api/v1/legal-entities", route => network ? route.abort("failed") : route.fulfill({ status,
    json: status === 200 ? { items: [] } : { error: { code: "service_unavailable", message: "unavailable", operation_id: "loader-reference" } },
  }));
  await page.route("**/api/v1/support-references", route => route.fulfill({ status: 503, json: {} }));
  await page.route("**/api/v1/auth/token/refresh", route => route.fulfill({ status: 401, json: { error: { code: "unauthorized", message: "ended" } } }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([401, 503])("Chromium: a loader %s stays in shell and retries in place", async code => {
  status = code;
  await page.goto(`${server.resolvedUrls!.local[0]}route-error-test`);
  const shell = page.locator("main[data-shell]");
  await element(shell.getByRole("alert")).toContainText("불러오지 못했습니다");
  await element(shell).toContainText("loader-reference");
  await element(shell.getByText("화면을 표시하지 못했습니다", { exact: true })).toHaveCount(0);
  status = 200;
  await shell.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await element(shell.locator("[data-loaded]")).toBeAttached();
  await element(shell.getByRole("alert")).toHaveCount(0);
});

test("Chromium: a transport TypeError recovers, a programming TypeError crashes", async () => {
  network = true;
  await page.goto(`${server.resolvedUrls!.local[0]}route-error-test`);
  await element(page.getByRole("alert")).toContainText("불러오지 못했습니다");
  network = false;
  status = 200;
  await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await element(page.locator("[data-loaded]")).toBeAttached();
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}route-error-test#bug`);
  await element(page.getByRole("alert")).toContainText("화면을 표시하지 못했습니다");
  expect(await page.getByRole("button", { name: "다시 불러오기", exact: true }).count()).toBe(0);
});
