// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { AT, id } from "../../../../../../e2e/mock/fixtures";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/tenants-page-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"], alias: [{ find: /^@console\/i18n$/, replacement: resolve("packages/i18n/src/index.ts") }] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "tenants-page-test", resolveId: key => key === "/tenants-test.js" ? "\0tenants-test" : undefined,
      load: key => key === "\0tenants-test" ? `
        import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createMemoryHistory,createRootRoute,createRoute,createRouter,RouterProvider} from '@tanstack/react-router';
        import {configure} from '@console/api'; import {loadCatalog} from '@console/i18n';
        import {TenantsPage} from '/apps/web/src/features/platform/ui/tenants-page.tsx';
        import {tenantsQuery} from '/apps/web/src/features/platform/api.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>null,create:async()=>null}});
        const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
        const root=createRootRoute(),app=createRoute({getParentRoute:()=>root,id:'app'});
        const route=createRoute({getParentRoute:()=>app,path:'/platform',component:TenantsPage});
        const router=createRouter({routeTree:root.addChildren([app.addChildren([route])]),history:createMemoryHistory({initialEntries:['/platform']})});
        window.refetchTenants=()=>client.refetchQueries(tenantsQuery);
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(RouterProvider,{router})));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/tenants-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Tenants</title><div id="root"></div><script type="module" src="/tenants-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390].flatMap(width => [0, 9].map(initial => ({ width, initial }))))("cached tenant counts from $initial update without moving controls or losing search focus at $width px", async ({ width, initial }) => {
  await page.setViewportSize({ width, height: 900 });
  let count = initial;
  await page.route("**/api/platform/orgs", route => route.fulfill({ json: Array.from({ length: count }, (_, index) => ({
    id: id(5000 + index), name: `검증 고객 ${index + 1}`, slug: `customer-${index + 1}`, group_id: null, group_slug: null, group_name: null,
    status: "ACTIVE", created_at: AT, updated_at: AT,
  })) }));
  await page.route("**/api/platform/ops", route => route.fulfill({ json: { tenants: [], notices: [] } }));
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}tenants-test`);
    const rows = page.locator("#tenants-list tbody tr");
    await element(page.locator("#tenants-list")).toBeVisible();
    await element(rows).toHaveCount(count);
    await page.evaluate(() => document.fonts.ready);
    const search = page.getByRole("search").getByRole("textbox");
    await element(search).toBeVisible();
    await search.focus();
    const controls = page.locator('.page__head button, .page__head input');
    const before = await controls.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
    count = 48;
    await page.evaluate(() => (window as unknown as { refetchTenants: () => Promise<void> }).refetchTenants());
    await element(rows).toHaveCount(count);
    expect(await controls.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))).toEqual(before);
    await element(search).toBeFocused();
    await element(page.getByRole("group").getByRole("button").first()).toContainText(String(count));
    count = 0;
    await page.evaluate(() => (window as unknown as { refetchTenants: () => Promise<void> }).refetchTenants());
    await element(rows).toHaveCount(0);
    expect(await controls.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))).toEqual(before);
    await element(search).toBeFocused();
    await element(page.getByRole("button", { name: t("tenants.create"), exact: true })).toHaveCount(1);
  } finally { await page.unroute("**/api/platform/orgs"); await page.unroute("**/api/platform/ops"); }
}, 60_000);
