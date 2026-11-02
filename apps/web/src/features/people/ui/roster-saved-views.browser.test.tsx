// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { commitLabel } from "../../../ui/composer/actions";
import { browserTestOptimizeDeps } from "../../../lib/browser-test";

let server: ViteDevServer, browser: Browser, page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/saved-views-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "saved-views-test",
      resolveId: id => id === "/saved-views-test.js" ? "\0saved-views-test" : undefined,
      load: id => id === "\0saved-views-test" ? `
        import { createElement as h } from 'react'; import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
        import { configure } from '@console/api'; import { loadCatalog } from '@console/i18n';
        import Gallery from '/apps/web/src/features/people/ui/roster-saved-views.gallery.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        configure({ baseUrl:location.origin, refresh:{kind:'cookie'}, passkeys:{get:async()=>null,create:async()=>null} });
        const client = new QueryClient({ defaultOptions:{queries:{retry:false}} });
        const router = createRouter({routeTree:createRootRoute(),history:createMemoryHistory()});
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(RouterContextProvider,{router},h(Gallery))));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/saved-views-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Views</title><div id="root"></div><script type="module" src="/saved-views-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([404, 405, 503])("saved views stay hidden until served and report status %s only when actionable", async status => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const writes: string[] = [];
  let available = false;
  await page.unrouteAll({ behavior: "wait" });
  await page.route("**/api/v1/me/employee-views", async route => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    await held;
    await route.fulfill(available ? { json: { items: [] } } : { status, json: { error: { code: "service_unavailable", message: "" } } });
  });
  const response = page.waitForResponse("**/api/v1/me/employee-views");
  const requested = page.waitForRequest("**/api/v1/me/employee-views");
  await page.goto(`${server.resolvedUrls!.local[0]}saved-views-test`);
  await requested;
  const open = page.getByRole("button", { name: t("directoryViews.open"), exact: true });
  await browserExpect(open).toHaveCount(0);
  release();
  expect((await response).status()).toBe(status);
  await browserExpect(open).toHaveCount(0);
  const retry = page.getByRole("button", { name: t("common.retry"), exact: true });
  if (status === 503) {
    await browserExpect(retry).toBeVisible();
    available = true;
    await retry.click();
    await browserExpect(open).toBeVisible();
    await open.click();
    await browserExpect(page.getByRole("button", { name: commitLabel({ kind: "directoryView", mode: "save" }), exact: true })).toBeEnabled();
  } else await browserExpect(retry).toHaveCount(0);
  expect(writes).toEqual([]);
});
