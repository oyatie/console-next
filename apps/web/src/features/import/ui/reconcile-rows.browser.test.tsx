// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { chromium, expect as expectDom, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps, openBrowserTestPage } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/reconcile-rows-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "reconcile-rows-test",
      resolveId: (id) => (id === "/reconcile-rows-test.js" ? "\0reconcile-rows-test" : undefined),
      load: (id) => (id === "\0reconcile-rows-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { i18n, loadCatalog } from '@console/i18n';
        import { ReconcileRows } from '/apps/web/src/features/import/ui/reconcile-rows.tsx';
        import '/apps/web/src/app.css';

        await loadCatalog('en');
        i18n.set('en');

        window.reconcileRequests = [];
        const origFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input.url;
          if (url.includes('/reconcile/rows/')) {
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            window.reconcileRequests.push({ url, body });
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (url.includes('/reconcile/rows')) {
            return new Response(JSON.stringify({
              items: [
                { source_key: 's1', sheet: 'Sheet1', row: 2, name: 'Kim', employee_number: 'E001', outcome: 'CREATED', state: 'UNCHECKED', version: 1, employee_id: null, company_confirmation: null },
              ],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return origFetch(input, init);
        };

        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        function App() {
          const initialFrozen = new URLSearchParams(location.search).get('frozen') === 'true';
          const [frozen, setFrozen] = useState(initialFrozen);
          window.syncFreezeAndPressY = (nextFrozen) => {
            flushSync(() => setFrozen(nextFrozen));
            const group = document.querySelector('[role="group"]');
            group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true, cancelable: true }));
          };
          return h(QueryClientProvider, { client: qc }, h(ReconcileRows, { runId: 'run-1', frozen }));
        }

        createRoot(document.getElementById('root')).render(h(App));
      ` : undefined),
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/reconcile-rows-test") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end('<!doctype html><html lang="en"><head><title>ReconcileRows</title></head><body><div id="root"></div><script type="module" src="/reconcile-rows-test.js"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test("ReconcileRows yn ref reflects frozen changes synchronously after flushSync before passive effects", async () => {
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}reconcile-rows-test`, page.getByRole("group"));
  await expectDom(page.getByText("E001")).toBeVisible();

  await page.evaluate(() => (window as unknown as { syncFreezeAndPressY: (f: boolean) => void }).syncFreezeAndPressY(true));
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as unknown as { reconcileRequests: unknown[] }).reconcileRequests)).toEqual([]);

  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}reconcile-rows-test?frozen=true`, page.getByRole("group"));
  await expectDom(page.getByText("E001")).toBeVisible();
  await page.evaluate(() => (window as unknown as { syncFreezeAndPressY: (f: boolean) => void }).syncFreezeAndPressY(false));
  await expect.poll(() => page.evaluate(() => (window as unknown as { reconcileRequests: unknown[] }).reconcileRequests.length)).toBe(1);
});
