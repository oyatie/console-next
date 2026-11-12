// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element, firefox } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
const browsers: Browser[] = [];
const pages = new Map<string, Page>();
const engines = [chromium, ...(process.env.E2E_XBROWSER === "1" ? [firefox] : [])];
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/change-notice-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{
      name: "change-notice-test",
      resolveId: id => id === "/change-notice-test.js" ? "\0change-notice-test" : undefined,
      load: id => id === "\0change-notice-test" ? `
        import React, { useEffect, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryObserver } from '@tanstack/react-query';
        import { loadCatalog } from '@console/i18n';
        import '/apps/web/src/app.css';
        import { ChangeNotice } from '/apps/web/src/ui/live/change-notice.tsx';
        import { Toast } from '/apps/web/src/ui/toast/toast.tsx';
        import { Receipt } from '/apps/web/src/ui/receipt/receipt.tsx';
        import { ActionBar } from '/apps/web/src/ui/action-bar/action-bar.tsx';
        import { HeldNotice } from '/apps/web/src/ui/live/held-notice.tsx';
        import { holdLive, openLive } from '/apps/web/src/lib/live/live.ts';
        import { get } from '/apps/web/src/lib/query.ts';
        await loadCatalog('ko');
        const client = new QueryClient();
        const query = get('/api/v1/employees/{id}', { params: { path: { id: 'person' } } });
        new QueryObserver(client, { ...query, queryFn: async () => ({}) }).subscribe(() => {});
        openLive(client, location.origin, options => {
          window.addEventListener('record-change', () => options.onFrame({ event: 'change', data: { type: 'employee', id: 'person', at: '2026-11-01T00:00:00Z' } }));
          return { get: () => ({ state: 'live', since: 0, partial: [] }), subscribe: () => () => {}, close() {}, reconnect() {} };
        });
        holdLive(true);
        function Fixture() {
          const [extras, setExtras] = useState(false);
          useEffect(() => {
            const toggle = () => setExtras(x => !x);
            window.addEventListener('toggle-extras', toggle);
            return () => window.removeEventListener('toggle-extras', toggle);
          }, []);
          useEffect(() => { document.documentElement.dataset.ready = 'true'; }, []);
          return React.createElement(React.Fragment, null,
            React.createElement('main', { style: { height: '2000px' } }, React.createElement('h1', null, '인사카드')),
            React.createElement(ChangeNotice),
            extras && React.createElement(React.Fragment, null,
              React.createElement(Toast, { state: 'done' }, '수정했습니다'),
              React.createElement(Receipt, { placement: 'docked', state: 'recorded', message: '기록했습니다' }),
              React.createElement(HeldNotice),
              React.createElement(ActionBar, { sticky: true, actions: React.createElement('button', null, '저장') })));
        }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      ` : undefined,
    }],
  });
  await server.listen();
  for (const engine of engines) {
    const browser = await engine.launch();
    browsers.push(browser);
    const page = await browser.newPage();
    pages.set(engine.name(), page);
    await page.route("**/change-notice-test", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<html lang="ko"><title>Change notice</title><div id="root"></div><script type="module" src="/change-notice-test.js"></script></html>' }));
    await page.goto(`${server.resolvedUrls!.local[0]}change-notice-test`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    await page.evaluate(() => document.fonts.ready);
  }
}, 60_000);
afterAll(async () => { await Promise.all(browsers.map(browser => browser.close())); await server?.close(); });

for (const engine of engines) test(`${engine.name()}: notices stay fixed and share the dock above sticky actions`, async () => {
  const page = pages.get(engine.name())!;
  const notice = page.getByRole("status").filter({ has: page.getByRole("button", { name: "알림 닫기", exact: true }) });
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.scrollTo(0, 0); }, theme);
    const heading = page.getByRole("heading", { name: "인사카드" });
    const before = await heading.boundingBox();
    await page.evaluate(() => window.dispatchEvent(new Event("record-change")));
    await element(notice).toBeVisible();
    expect((await heading.boundingBox())!.y).toBe(before!.y);
    await page.evaluate(() => window.scrollTo(0, 400));
    let box = (await notice.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await page.evaluate(() => window.dispatchEvent(new Event("toggle-extras")));
    const save = page.getByRole("button", { name: "저장", exact: true });
    await element(save).toBeVisible();
    await element(page.getByRole("status").filter({ hasText: "수정했습니다" })).toBeVisible();
    await element(page.getByRole("status").filter({ hasText: "기록했습니다" })).toBeVisible();
    await element(page.getByRole("status")).toHaveCount(4);
    await element(page.getByRole("button", { name: /새 항목/ })).toBeVisible();
    await element.poll(async () => {
      const statuses = await page.getByRole("status").all();
      const boxes = await Promise.all(statuses.map(status => status.boundingBox()));
      const action = (await save.boundingBox())!;
      return boxes.every((a, i) => a && a.y >= 0 && a.y + a.height <= action.y && boxes.slice(i + 1).every(b => b && (a.y + a.height <= b.y || b.y + b.height <= a.y)));
    }).toBe(true);
    await save.click();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event("toggle-extras")));
    box = (await notice.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "알림 닫기", exact: true }).click();
    await element(notice).toHaveCount(0);
  }
});
