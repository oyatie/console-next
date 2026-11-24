// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { i18n, loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { failure, id } from "../../../../../../e2e/mock/fixtures";
import { mockRoute } from "../../../../../../e2e/mock/route";

const [fixture] = Object.values(import.meta.glob<string>("./request-page.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("en");
  i18n.set("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/request-page-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/requests/ui/request-page.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), realpathSync("node_modules/pretendard")] } },
  });
  await server.listen();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { i18n.set("ko"); await browser?.close(); await server?.close(); });

// The answer can land before the page's own code for the style has loaded; the screen must still show it.
test.each(["baseline", "console"])("%s: a request the server does not know shows not found when the answer lands before the screen's code", async look => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route("**/request-page-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Request</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
    await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({ status: 501, json: failure("unmocked_request") }));
    const answered = page.waitForResponse(response => new URL(response.url()).pathname.startsWith("/api/v1/requests/"));
    await mockRoute(page, "get", "/api/v1/requests/{key}", { status: 404, json: failure("request_not_found") });
    // The Console screen's chunk is held until the 404 has reached the page and its read has settled.
    await page.route(url => url.pathname.endsWith("/request-console.tsx"), async route => {
      await (await answered).finished();
      await page.evaluate(() => new Promise<void>(done => { let n = 6; const tick = () => (--n ? requestAnimationFrame(tick) : done()); tick(); }));
      await route.continue();
    });
    await page.goto(`${server.resolvedUrls!.local[0]}request-page-test?id=${id(99)}&look=${look}`);
    const main = look === "console" ? page.locator("[data-pattern=record]") : page.locator("main");
    await element(main.getByRole("heading", { name: t("common.read.notFound.title"), exact: true })).toBeVisible({ timeout: 15_000 });
    await element(main).toContainText(t("requestOutcome.notFound"));
    await element(main.getByText(t("common.loading"), { exact: true })).toHaveCount(0);
  } finally { await page.close(); }
}, 90_000);
