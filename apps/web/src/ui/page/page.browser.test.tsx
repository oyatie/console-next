// SPDX-License-Identifier: LicenseRef-Proprietary
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/page-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" },
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "page-test", resolveId: id => id === "/page-test.js" ? "\0page-test" : undefined,
      load: id => id === "\0page-test" ? `
        import React, {useState,useEffect} from 'react'; import {createRoot} from 'react-dom/client';
        import {createMemoryHistory,createRootRoute,createRouter,RouterProvider} from '@tanstack/react-router';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {loadCatalog} from '@console/i18n';
        import Gallery from '/apps/web/src/gallery/sections/page.gallery.tsx';
        import {PageMain} from '/apps/web/src/ui/page/page-main.tsx';
        import {ListPage} from '/apps/web/src/ui/templates/list-page.tsx';
        import {SearchField} from '/apps/web/src/ui/search/search-field.tsx';
        import {ApiError} from '@console/api';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function FilterDemo() {
          const [mode,setMode]=useState('populated'), [text,setText]=useState('');
          useEffect(()=>{
            const read=event=>setMode(event.detail);
            document.addEventListener('read-test',read);
            return ()=>document.removeEventListener('read-test',read);
          },[]);
          const q={isPending:mode==='loading',data:mode==='loading'||mode==='failed'?undefined:[],refetch(){},
            error:mode==='refused'?new ApiError(403,'access_denied','',[],'filter-refusal'):mode==='failed'?new ApiError(503,'service_unavailable','',[],'filter-failure'):null};
          return React.createElement('div',{'data-read-mode':mode},React.createElement(ListPage,{q,head:{title:'Employees'},
            filters:React.createElement(SearchField,{label:'Find',value:text,onChange:setText})},()=>React.createElement('p',null,'Body')));
        }
        const client=new QueryClient({defaultOptions:{queries:{enabled:false,retry:false}}});
        const route=createRootRoute({component:()=>React.createElement(PageMain,null,React.createElement(QueryClientProvider,{client},React.createElement(new URL(location.href).searchParams.has('filters')?FilterDemo:Gallery)))});
        const router=createRouter({routeTree:route,history:createMemoryHistory({initialEntries:['/']})});
        await router.load();
        createRoot(document.getElementById('root')).render(React.createElement(RouterProvider,{router}));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  await page.route(url => url.pathname === "/page-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Page</title><div id="root"></div><script type="module" src="/page-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`frame states and actions at ${width}px in ${theme}`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}page-test`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const frame = page.locator('[data-floorplan="list"]');
    const title = frame.getByRole("heading", { level: 1, name: tg("pageHead.list"), exact: true });
    await element(title).toBeVisible();
    const states = page.getByRole("group", { name: tg("section.states"), exact: true }).getByRole("button");
    for (let i = 0; i < 7; i++) {
      await states.nth(i).click();
      await element(page.locator("main")).toHaveCount(1);
      await element(page.locator("h1")).toHaveCount(1);
      await element(frame.locator("header nav").first()).toBeVisible();
      if (i === 0) await element(frame.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
      if (i === 1) await element(frame.getByText(tg("empty.title"), { exact: true })).toBeVisible();
      if (i === 2) {
        await element(frame.getByRole("alert")).toHaveCount(1);
        await element(frame.getByText("gallery-page-read", { exact: true })).toBeVisible();
        await frame.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await element(frame.getByRole("grid")).toBeVisible();
      }
      if (i === 3) {
        await element(frame.getByRole("grid")).toHaveCount(0);
        await element(frame.getByRole("button", { name: tg("pageHead.add"), exact: true })).toHaveCount(0);
        await frame.getByText(t("common.denied.why"), { exact: true }).click();
        await element(frame.getByText("gallery-page-refusal", { exact: true })).toBeVisible();
      }
      if (i === 6) {
        await element(frame.getByRole("rowheader").first()).toBeVisible();
        expect(await frame.getByRole("rowheader").count()).toBeLessThanOrEqual(50);
        await element(frame.locator("header")).toContainText("2,000");
      }
      expect(await frame.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    const primary = frame.getByRole("button", { name: tg("pageHead.add"), exact: true });
    if (width === 390) {
      await element(frame.getByRole("button", { name: tg("pageHead.export"), exact: true })).toBeHidden();
      const more = frame.getByRole("button", { name: t("uiRecordActions.more", { field: tg("pageHead.list") }), exact: true });
      await more.focus();
      await more.press("Enter");
      await element(page.getByRole("menuitem", { name: tg("pageHead.export"), exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await element(more).toBeFocused();
    } else await element(frame.getByRole("button", { name: tg("pageHead.export"), exact: true })).toBeVisible();
    await primary.click();
    await element(page.getByRole("dialog")).toBeVisible();
    expect(await page.locator("h1").count()).toBe(1);
    expect(await page.locator("main").count()).toBe(1);
    await element(page.getByRole("dialog").getByRole("heading", { level: 2, name: tg("sheet.subtitle"), exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await element(primary).toBeFocused();
  });
}

test.each([1440, 390])("a count arriving keeps the head, primary action and tabs in place at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}page-test`);
  const frame = page.locator('[data-floorplan="list"]');
  const states = page.getByRole("group", { name: tg("section.states"), exact: true }).getByRole("button");
  await states.nth(0).click();
  const primary = frame.getByRole("button", { name: tg("pageHead.add"), exact: true });
  await element(primary).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const before = await primary.boundingBox();
  const tabs = frame.getByRole("navigation", { name: tg("pageHead.list"), exact: true });
  const tabsBefore = await tabs.boundingBox();
  await states.nth(6).click();
  expect(await primary.boundingBox()).toEqual(before);
  expect(await tabs.boundingBox()).toEqual(tabsBefore);
});

test("list filters retain their value and focus across reads, and disappear on refusal", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}page-test?filters`);
  const input = page.getByRole("searchbox", { name: "Find", exact: true });
  await input.fill("typed");
  for (const mode of ["loading", "failed", "populated"]) {
    await page.evaluate(value => document.dispatchEvent(new CustomEvent("read-test", { detail: value })), mode);
    await element(page.locator("[data-read-mode]")).toHaveAttribute("data-read-mode", mode);
    await element(input).toBeFocused();
    await element(input).toHaveValue("typed");
  }
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("read-test", { detail: "refused" })));
  await element(input).toHaveCount(0);
  await element(page.locator("h1")).toHaveCount(1);
});
