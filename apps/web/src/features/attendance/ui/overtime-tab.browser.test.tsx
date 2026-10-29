// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as expectElement } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let pages: [Page, Page];
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/overtime-tab-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    define: { "process.env.VIRT_ON": "true" },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "overtime-tab-test",
      resolveId: id => id === "/overtime-test.js" ? "\0overtime-test" : undefined,
      load: id => id === "\0overtime-test" ? `
        import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
        import {createRootRoute, createRoute, createRouter, RouterProvider, createMemoryHistory} from '@tanstack/react-router';
        import {loadCatalog} from '@console/i18n';
        import {week52Query, treeQuery} from '/apps/web/src/features/attendance/api.ts';
        import {OvertimeTab} from '/apps/web/src/features/attendance/ui/overtime-tab.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const client = new QueryClient({defaultOptions:{queries:{staleTime:Infinity, retry:false}}});
        await client.fetchQuery({...treeQuery(), queryFn:async()=>({nodes:[]})});
        await client.fetchQuery({...week52Query('2026-10-04'), queryFn:async()=>({week_start:'2026-09-28',items:[
          {employee_id:'known', name:'Known', week_start:'2026-09-28', current_hours:1, projected_hours:1, recognized_hours:37.25, overtime_hours:2.25, tone:'DANGER', acked:false},
          {employee_id:'unknown', name:'Unknown', week_start:'2026-09-28', current_hours:0, projected_hours:0, tone:'UNKNOWN', acked:false}
        ]})});
        const root = createRootRoute();
        const app = createRoute({getParentRoute:()=>root,id:'app'});
        const attendance = createRoute({getParentRoute:()=>app,path:'/attendance',validateSearch:s=>s,component:OvertimeTab});
        const router = createRouter({routeTree:root.addChildren([app.addChildren([attendance])]),history:createMemoryHistory({initialEntries:['/attendance?tab=overtime&date=2026-10-04']})});
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(RouterProvider,{router})));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/overtime-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Overtime</title><div id="root"></div><script type="module" src="/overtime-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  pages = await Promise.all([browser.newPage({ viewport: { width: 1440, height: 900 } }), browser.newPage({ viewport: { width: 390, height: 900 } })]);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390])("week52 preserves unknown totals and the server tone at %spx", async width => {
  const page = pages[width === 1440 ? 0 : 1];
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}overtime-test`);
    await expectElement(page.getByRole("grid")).toBeVisible();
    await expectElement(page.getByText("37.25시간", { exact: true })).toBeVisible();
    await expectElement(page.getByText("2.25시간", { exact: true })).toBeVisible();
    await expectElement(page.getByText("위험", { exact: true })).toBeVisible();
    await expectElement(page.getByText("미제공", { exact: true })).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  } finally { await page.close(); }
});
