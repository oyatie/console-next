// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element, firefox } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
const browsers: Browser[] = [];
const pages: Page[] = [];
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/change-notice-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{
      name: "change-notice-test",
      resolveId: id => id === "/change-notice-test.js" ? "\0change-notice-test" : undefined,
      load: id => id === "\0change-notice-test" ? `
        import React, { useEffect } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryObserver } from '@tanstack/react-query';
        import { loadCatalog } from '@console/i18n';
        import '/apps/web/src/app.css';
        import { ChangeNotice } from '/apps/web/src/ui/live/change-notice.tsx';
        import { openLive } from '/apps/web/src/lib/live/live.ts';
        import { get } from '/apps/web/src/lib/query.ts';
        await loadCatalog('ko');
        const client = new QueryClient();
        const query = get('/api/v1/employees/{id}', { params: { path: { id: 'person' } } });
        new QueryObserver(client, { ...query, queryFn: async () => ({}) }).subscribe(() => {});
        openLive(client, location.origin, options => {
          window.addEventListener('record-change', () => options.onFrame({ event: 'change', data: { type: 'employee', id: 'person', at: '2026-11-01T00:00:00Z' } }));
          return { get: () => ({ state: 'live', since: 0, partial: [] }), subscribe: () => () => {}, close() {}, reconnect() {} };
        });
        function Fixture() {
          useEffect(() => { document.documentElement.dataset.ready = 'true'; }, []);
          return React.createElement(ChangeNotice);
        }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      ` : undefined,
    }],
  });
  await server.listen();
  for (const engine of [chromium, firefox]) {
    const browser = await engine.launch();
    browsers.push(browser);
    const page = await browser.newPage();
    pages.push(page);
    await page.route("**/change-notice-test", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<html lang="ko"><title>Change notice</title><div id="root"></div><button id="under" onclick="this.dataset.clicked=\'true\'">발령</button><script type="module" src="/change-notice-test.js"></script></html>' }));
    await page.goto(`${server.resolvedUrls!.local[0]}change-notice-test`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    await page.evaluate(() => window.dispatchEvent(new Event("record-change")));
    await page.getByRole("status").waitFor();
    await page.evaluate(() => document.fonts.ready);
  }
}, 60_000);
afterAll(async () => { await Promise.all(browsers.map(browser => browser.close())); await server?.close(); });

for (const [index, engine] of ["Chromium", "Firefox"].entries()) test(`${engine}: a change notice leaves underlying actions reachable and can still be dismissed`, async () => {
  const page = pages[index]!;
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
    const text = await page.getByRole("status").locator("span").boundingBox();
    await page.locator("#under").evaluate((el, box) => {
      el.removeAttribute("data-clicked");
      Object.assign(el.style, { position: "fixed", left: `${box!.x}px`, top: `${box!.y}px`, zIndex: "0" });
    }, text);
    await page.getByRole("button", { name: "발령", exact: true }).click({ timeout: 1_000 });
    await element(page.locator("#under")).toHaveAttribute("data-clicked", "true");
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
    if (width === 390) expect(await page.getByRole("status").evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(width / 2);
    await page.screenshot({ path: resolve(".cache/change-notice-test", `${engine}-${width}-${theme}.png`) });
  }
  await page.getByRole("button", { name: "알림 닫기", exact: true }).click();
  await element(page.getByRole("status")).toHaveCount(0);
});
