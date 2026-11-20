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
    cacheDir: ".cache/outline-view-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "outline-view-test",
      resolveId: (id) => (id === "/outline-view-test.js" ? "\0outline-view-test" : undefined),
      load: (id) => (id === "\0outline-view-test" ? `
        import { createElement as h, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { createRootRoute, createRoute, createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router';
        import { i18n, loadCatalog } from '@console/i18n';
        import { buildStructure } from '/apps/web/src/features/structure/domain/model.ts';
        import { OutlineView } from '/apps/web/src/features/structure/ui/outline-view.tsx';
        import '/apps/web/src/app.css';

        await loadCatalog('en');
        i18n.set('en');

        const s = buildStructure({
          tenant_name: 'T',
          phase: 'SETUP',
          entities: [{
            id: 'e1',
            kind: 'LEGAL_ENTITY',
            name: 'HQ Entity',
            headcount: 7,
            direct_headcount: 0,
            chips: [],
            children: [{
              id: 'w1',
              kind: 'WORKPLACE',
              name: 'Seoul',
              headcount: 7,
              direct_headcount: 0,
              chips: [],
              children: [
                { id: 'd1', kind: 'DEPARTMENT', name: 'Alpha Dept', code: 'ALP', headcount: 3, direct_headcount: 3, chips: [], children: [] },
                { id: 'd2', kind: 'DEPARTMENT', name: 'Beta Dept', code: 'BET', headcount: 4, direct_headcount: 4, chips: [], children: [] },
              ],
            }],
          }],
        });

        window.outlineCalls = [];
        function App() {
          const [sel, setSel] = useState(() => new Set(['d1']));
          const [tag, setTag] = useState('v1');
          const [follow, setFollow] = useState(true);
          const ref = useRef(null);

          window.moveOutlineCursor = () => {
            ref.current.find(1);
          };
          window.syncAndSettle = (nextFollow) => {
            flushSync(() => {
              setTag('v2');
              setFollow(nextFollow);
            });
            const cb = window.settleCallbacks.pop();
            cb?.();
          };

          return h(OutlineView, {
            ref,
            s,
            cmd: { busy: false },
            sel,
            follow,
            find: 'Beta',
            onSelect: (ids) => {
              window.outlineCalls.push(tag + ':' + [...ids].join(','));
              setSel(ids);
            },
          });
        }

        const root = createRootRoute();
        const appRoute = createRoute({ getParentRoute: () => root, id: '/app' });
        const orgRoute = createRoute({ getParentRoute: () => appRoute, path: '/org', component: App });
        const router = createRouter({ routeTree: root.addChildren([appRoute.addChildren([orgRoute])]), history: createMemoryHistory({ initialEntries: ['/org'] }) });
        createRoot(document.getElementById('root')).render(h(RouterProvider, { router }));
      ` : undefined),
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/outline-view-test") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end('<!doctype html><html lang="en"><head><title>OutlineView</title></head><body><div id="root"></div><script type="module" src="/outline-view-test.js"></script></body></html>');
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

test("OutlineView settle timer reads updated onSelect and follow refs synchronously after flushSync", async () => {
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}outline-view-test`, page.getByRole("heading", { level: 2 }));
  await expectDom(page.getByRole("treeitem", { name: /Beta Dept/ })).toBeVisible();

  await page.evaluate(() => {
    const origSetTimeout = window.setTimeout.bind(window);
    const w = window as unknown as { settleCallbacks: (() => void)[]; moveOutlineCursor: () => void };
    w.settleCallbacks = [];
    window.setTimeout = ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 150) {
        w.settleCallbacks.push(() => fn(...args));
        return 999000 + w.settleCallbacks.length;
      }
      return origSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout;
    w.moveOutlineCursor();
  });
  await expectDom(page.locator('#outline-d2[data-current="true"]')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { syncAndSettle: (f: boolean) => void }).syncAndSettle(true);
  });

  const calls = await page.evaluate(() => (window as unknown as { outlineCalls: string[] }).outlineCalls);
  expect(calls).toEqual(["v2:d2"]);
});
