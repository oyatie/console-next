// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as dom, type Browser, type Page, type Route } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps } from "../../../lib/browser-test";

let server: ViteDevServer, browser: Browser, page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/roster-layout-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "roster-layout-test",
      resolveId: id => id === "/roster-layout-test.js" ? "\0roster-layout-test" : undefined,
      load: id => id === "\0roster-layout-test" ? `
        import { createElement as h, useState } from 'react'; import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { configure } from '@console/api'; import { loadCatalog, t } from '@console/i18n';
        import { RosterHead } from '/apps/web/src/features/people/ui/roster-head';
        import { RosterPage } from '/apps/web/src/features/people/ui/roster-page';
        import { RosterFilters } from '/apps/web/src/features/people/ui/roster-filters';
        import { RosterTable } from '/apps/web/src/features/people/ui/roster-table';
        import { RosterColumns } from '/apps/web/src/features/people/ui/roster-columns';
        import { RosterSavedViews } from '/apps/web/src/features/people/ui/roster-saved-views';
        import { OPTIONAL_COLUMNS as DEFAULT_COLUMNS } from '/apps/web/src/features/people/domain/columns';
        import { Button, ToggleButton } from '/apps/web/src/ui/button/button';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        configure({ baseUrl:location.origin, refresh:{kind:'cookie'}, passkeys:{get:async()=>null,create:async()=>null} });
        const client = new QueryClient({ defaultOptions:{queries:{retry:false}} });
        function Fixture() {
          const [slot,setSlot] = useState(null), [table,setTable] = useState(false);
          const noop = () => {};
          if (new URLSearchParams(location.search).has('unit')) return h('main',{style:{width:new URLSearchParams(location.search).get('width')}},
            h(RosterPage,{manage:true,switcher:h('div',{className:'row'},h(ToggleButton,{pressed:true},t('people.tab.employees')),h(ToggleButton,{pressed:false},t('people.tab.accounts')))}));
          return h('div',null,
            h(Button,{onClick:()=>setTable(value=>!value)},t('common.retry')),
            h('main',{style:{maxWidth:new URLSearchParams(location.search).get('width')}},
              h(RosterHead,{manage:true,status:'current',review:[],soonDays:table?60:undefined,onView:noop,
                switcher:h('div',{className:'row'},h(ToggleButton,{pressed:true},t('people.tab.employees')),h(ToggleButton,{pressed:false},t('people.tab.accounts')))}),
              h(RosterFilters,{status:'current',review:[],soonDays:60,
                counts:{status:{totals:{ACTIVE:0,ON_LEAVE:0,PRE_HIRE:0,EXITED:0},failed:[]},review:{totals:{contractSoon:0},failed:[]}},
                onChange:noop,findSlot:setSlot,density:'regular',onDensity:noop,
                tools:h('span',{style:{display:'contents'}},h(RosterColumns,{shown:DEFAULT_COLUMNS,onChange:noop,density:'regular',onDensity:noop}),h(RosterSavedViews,{filters:{},onApply:noop}))}),
              table && h(RosterTable,{rows:[],today:'2026-01-01',shown:DEFAULT_COLUMNS,density:'regular',label:t('people.table'),hasMore:false,onLoadMore:noop,empty:null,loading:true,find:{label:t('roster.find'),onFind:noop},findSlot:slot})));
        }
        const root = createRootRoute(), app = createRoute({getParentRoute:()=>root,id:'app'});
        const people = createRoute({getParentRoute:()=>app,path:'people',validateSearch:search=>search,component:Fixture,beforeLoad:()=>({peopleAccess:{unplaced:{domain:'hr_basic',level:'edit',tenant:true}}})});
        const router = createRouter({routeTree:root.addChildren([app.addChildren([people])]),history:createMemoryHistory({initialEntries:['/people'+(new URLSearchParams(location.search).has('unit')?'?unit=department':'')]})});
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(RouterProvider,{router})));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/roster-layout-test?")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roster</title><div id="root"></div><script type="module" src="/roster-layout-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  page = await browser.newPage();
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === "/api/v1/access/me" ? { is_ops: true, entries: [] } : path === "/api/v1/org-structure" ? { entities: [] } : { items: [] } });
  });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1012, 1172, 760, 390].flatMap(width => ["light", "dark"].map(theme => ({ width, theme }))))("roster filters stay in place when the table search mounts and unmounts at $width px in $theme", async ({ width, theme }) => {
  await page.setViewportSize({ width: width === 390 ? width : 1280, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}roster-layout-test?width=${width}px`);
  await dom(page.getByRole("button", { name: t("roster.scope.open", { scope: t("roster.scope.all") }), exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
  const filters = page.getByRole("group", { name: t("people.filter.label"), exact: true });
  const controls = filters.getByRole("button");
  const positions = () => controls.evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  const before = await filters.boundingBox();
  const beforeControls = await positions();
  const toggle = page.getByRole("button", { name: t("common.retry"), exact: true });
  await toggle.click();
  await dom(page.getByRole("searchbox", { name: t("roster.find"), exact: true })).toBeVisible();
  expect(await filters.boundingBox()).toEqual(before);
  expect(await positions()).toEqual(beforeControls);
  const search = await page.getByRole("searchbox").boundingBox();
  expect(search!.x).toBeGreaterThanOrEqual(0);
  expect(search!.x + search!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await toggle.click();
  await dom(page.getByRole("searchbox")).toHaveCount(0);
  expect(await filters.boundingBox()).toEqual(before);
  expect(await positions()).toEqual(beforeControls);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test.each([1012, 390].flatMap(width => ["light", "dark"].map(theme => ({ width, theme }))))("a unit-filtered roster loading zero rows keeps its filter band at $width px in $theme", async ({ width, theme }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const respond = async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/employees") {
      await pending;
      return route.fulfill({ json: { items: [], total: 0, next_cursor: null } });
    }
    if (path === "/api/v1/settings") return route.fulfill({ json: { items: [{ key: "hr.contract_soon_days", value: 60 }] } });
    if (path === "/api/v1/employees/facets") return route.fulfill({ json: { total: 0, status: [], review: {
      contract_ended: 0, contract_ending_before: 0, identity_review_required: 0, home_branch_review_required: 0,
      register_review_required: 0, lifecycle_apply_failed: 0, department_missing: 0,
    } } });
    return route.fallback();
  };
  await page.route("**/api/v1/**", respond);
  try {
    await page.setViewportSize({ width: width === 390 ? width : 1280, height: 900 });
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === "/api/v1/employees" && new URL(request.url()).searchParams.get("org_unit_id") === "department");
    await page.goto(`${server.resolvedUrls!.local[0]}roster-layout-test?width=${width}px&unit=department`);
    await requested;
    const reset = page.getByRole("button", { name: t("people.filter.reset"), exact: true });
    await dom(reset).toHaveCount(1);
    await dom(page.getByRole("button", { name: t("roster.scope.open", { scope: t("roster.scope.all") }), exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const filters = page.getByRole("group", { name: t("people.filter.label"), exact: true });
    await dom(filters).not.toHaveAttribute("data-pending", "true");
    const before = await filters.boundingBox();
    const resetBefore = await reset.boundingBox();
    release();
    await dom(page.getByRole("heading", { name: t("people.noMatch.title"), exact: true })).toBeVisible();
    await dom(page.getByRole("searchbox", { name: t("roster.find"), exact: true })).toBeVisible();
    expect(await filters.boundingBox()).toEqual(before);
    await dom(reset).toHaveCount(1);
    expect(await reset.boundingBox()).toEqual(resetBefore);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await reset.click();
    await dom(page.getByRole("button", { name: t("people.filter.anyUnit"), exact: true })).toHaveCount(0);
    await dom(reset).toHaveCount(0);
  } finally {
    release();
    await page.unroute("**/api/v1/**", respond);
  }
});
