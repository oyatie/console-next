// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, browserTestOptimizeDeps, type Browser, type Page } from "../../../lib/browser-test";
import { expect as expectElement } from "@playwright/test";

let server: ViteDevServer;
let browser: Browser;
let pages: [Page, Page];
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/scope-tree-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "scope-tree-test",
      resolveId: id => id === "/scope-tree-test.js" ? "\0scope-tree-test" : undefined,
      load: id => id === "\0scope-tree-test" ? `
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { createRootRoute, createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router';
        import { loadCatalog } from '@console/i18n';
        import { ScopeTree } from '/apps/web/src/features/attendance/ui/scope-tree.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const tree = { date: '2026-10-26', people_total: 3, people_unscheduled: 3, holidays_loaded: true, nodes: [
          { id: 'entity', kind: 'LEGAL_ENTITY', name: '법인', people: 3, effective: null, unscheduled: 3 },
          { id: 'wp', parent_id: 'entity', kind: 'WORKPLACE', name: '판교지점', people: 3, effective: null, unscheduled: 3 },
          { id: 'team', parent_id: 'wp', kind: 'DEPARTMENT', name: '영업1팀', people: 3, effective: null, unscheduled: 3 },
        ] };
        const root = createRootRoute({ component: () => h(ScopeTree, { tree, selected: 'wp', onSelect: () => {}, onPerson: () => {} }) });
        const router = createRouter({ routeTree: root, history: createMemoryHistory() });
        createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: new QueryClient() }, h(RouterProvider, { router })));
      ` : undefined,
      configureServer: vite => {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/scope-tree-test") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html lang="ko"><title>Schedule scopes</title><div id="root"></div><script type="module" src="/scope-tree-test.js"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  pages = await Promise.all([
    browser.newPage({ viewport: { width: 1440, height: 900 } }),
    browser.newPage({ viewport: { width: 390, height: 900 } }),
  ]);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390])("scope rows wrap and their count links are keyboard reachable at %spx", async width => {
  const page = pages[width === 1440 ? 0 : 1];
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}scope-tree-test`);
    const workplace = page.getByRole("row", { name: /^판교지점/ });
    const count = workplace.getByRole("link", { name: "일정 없음 3명", exact: true });
    await expectElement(count).toBeVisible();
    await workplace.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Tab");
    await expectElement(count).toBeFocused();
    expect(await count.getAttribute("href")).toContain("wp=wp");
    const geometry = await workplace.evaluate(el => {
      const row = el.getBoundingClientRect();
      const link = el.querySelector('a')!.getBoundingClientRect();
      return { fits: link.bottom <= row.bottom && link.right <= row.right, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(geometry).toEqual({ fits: true, overflow: 0 });
  } finally { await page.close(); }
});
