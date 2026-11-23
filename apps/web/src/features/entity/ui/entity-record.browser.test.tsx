// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect as dom, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage } from "../../../lib/browser-test";

beforeAll(async () => {
  await loadCatalog("ko");
});

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/entity-record-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [{
      name: "entity-record-test",
      resolveId: id => id === "/record-test.tsx" ? "\0record-test.tsx" : undefined,
      load: id => id === "\0record-test.tsx" ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { loadCatalog } from '@console/i18n';
        import { EntityRecord } from '/apps/web/src/features/entity/ui/entity-record.tsx';
        import { ApiError, entityQuery } from '/apps/web/src/features/entity/api.ts';
        import { checklistRef } from '/apps/web/src/reference/entity/api.ts';
        import { myAccessQuery } from '/apps/web/src/reference/authz/api.ts';
        import { settingsQuery } from '/apps/web/src/reference/settings/api.ts';
        await loadCatalog('ko');
        const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
        const entityData = {
          id: 'entity', biz_kind: 'CORPORATION', can_manage: true,
          current: { name: '주식회사 누리', representatives: [], directors: [] },
          registrations: [{ id: 'reg-1', closed_on: null, current: { business_types: [] }, verification: { status: 'UNVERIFIED' } }],
          workplaces: [], scheduled: [], identity_problems: [], name_reviews: [],
          regular_workers: { value: null, status: 'HOLD', live_headcount: 0, missing: [], basis: 'LSA_DECREE_7_2' },
        };
        await client.fetchQuery({ ...entityQuery('entity'), queryFn: async () => entityData });
        await client.fetchQuery({ ...checklistRef, queryFn: async () => ({ phase: 'OPERATING' }) });
        await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ phase: 'OPERATING', is_ops: false, entries: [] }) });
        await client.fetchQuery({ ...settingsQuery, queryFn: async () => { throw new Error('unavailable'); } }).catch(() => {});
        const root = createRootRoute();
        const app = createRoute({ getParentRoute: () => root, id: 'app' });
        const detail = createRoute({ getParentRoute: () => app, path: '/org/entities/$id', component: () => React.createElement(React.Fragment, null,
          React.createElement('button', { onClick: () => { void client.fetchQuery({ ...settingsQuery, queryFn: () => new Promise(() => {}) }); } }, 'Refresh settings'),
          React.createElement('button', { onClick: () => {
            document.documentElement.dataset.experience = 'console';
            void router.navigate({ to: '/org/entities/$id', params: { id: 'entity' }, search: { reissue: 'reg-1' } });
          } }, 'Open console reissue'),
          (window.__refuseEntity = () => client.fetchQuery({ ...entityQuery('entity'), queryFn: async () => { throw new ApiError(403, 'forbidden', 'denied'); } }).catch(() => {}), null),
          React.createElement(EntityRecord, { id: 'entity' }),
        ) });
        const router = createRouter({ routeTree: root.addChildren([app.addChildren([detail])]) });
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })));
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => !url.pathname.includes(".") && !url.pathname.startsWith("/@"), route => route.fulfill({
    contentType: "text/html", body: '<div id="root"></div><script type="module" src="/record-test.tsx"></script>',
  }));
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}org/entities/entity`, page.getByRole("heading", { name: "주식회사 누리", level: 1 }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("a failed side read stays released when another refresh starts", async () => {
  const heading = page.getByRole("heading", { name: "주식회사 누리", level: 1 });
  await dom(heading).toBeVisible();
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await dom(heading).toBeVisible();
  await dom(page.locator('[data-read-layout="record"][aria-busy="true"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Console mode does not render overlays when activeQ has stale data alongside ApiError(403)", async () => {
  await page.getByRole("button", { name: "Open console reissue", exact: true }).click();
  await dom(page.locator('[data-pattern="record"]')).toHaveAttribute("data-floorplan", "P-02");
  await dom(page.getByRole("heading", { name: t("entityReissue.title") })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __refuseEntity: () => Promise<unknown> }).__refuseEntity());
  await dom(page.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
  await dom(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
