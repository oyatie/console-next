// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/long-table-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "long-table-test",
      resolveId: id => id === "/long-table-test.js" ? "\0long-table-test" : undefined,
      load: id => id === "\0long-table-test" ? `
        import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import {LongTable} from '/apps/web/src/ui/long-table/long-table.tsx';
        import {NO_SELECTION} from '/apps/web/src/ui/long-table/selection.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function Fixture(){
          const [sort,setSort]=useState({column:'name',direction:'ascending'});
          const [selection,setSelection]=useState(NO_SELECTION);
          const collision=location.search.startsWith('?collision');
          const rows=collision ? ['name','__select','__card','row:name'].map((id,i)=>({id,name:'가상'+i,note:id}))
            : [{id:'a',name:'가상가',note:'첫째'},{id:'b',name:'가상나',note:'둘째'}];
          return React.createElement(LongTable,{
            label:'정렬 검증',rows,rowId:r=>r.id,empty:null,hasMore:false,onLoadMore:()=>{},
            caption:sort.column+':'+sort.direction,
            sortDescriptor:sort,onSortChange:location.search==='?readonly'?undefined:setSort,
            ...(collision ? {...(location.search==='?collision' ? {selection,onSelectionChange:s=>{setSelection(s);document.body.dataset.selection=JSON.stringify(s.kind==='ids'?[...s.ids]:[...s.excluded]);}} : {}),
              rowKeys:{},onRowAction:id=>document.body.dataset.action=id,
              onRowFocus:id=>document.body.dataset.focus=id,onRowHover:id=>document.body.dataset.hover=id} : {}),
            columns:[{id:'name',header:'이름',card:location.search==='?rows'?undefined:'title',rowHeader:true,allowsSorting:true,cell:r=>r.name},
              {id:'note',header:'메모',allowsSorting:true,cell:r=>r.note},
              {id:'fixed',header:'고정',cell:()=>'-'}]
          });
        }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/long-table-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Table</title><div id="root"></div><script type="module" src="/long-table-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440].flatMap(width => ["light", "dark"].map(theme => ({ width, theme }))))(
  "headers expose and change the controlled order at $width px in $theme", async ({ width, theme }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const name = page.getByRole("columnheader", { name: "이름", exact: true });
    await name.waitFor();
    expect(await name.getAttribute("aria-sort")).toBe("ascending");
    await name.focus();
    await name.press("Enter");
    await page.waitForFunction(() => document.querySelector('[aria-sort="descending"]'));
    expect(await name.getAttribute("aria-sort")).toBe("descending");
    await name.click();
    await page.waitForFunction(() => document.querySelector('[aria-sort="ascending"]'));
    expect(await name.getAttribute("aria-sort")).toBe("ascending");
    const note = page.getByRole("columnheader", { name: "고정", exact: true });
    await note.click();
    expect(await note.getAttribute("aria-sort")).toBeNull();
    expect(await name.getAttribute("aria-sort")).toBe("ascending");
    expect(await page.getByRole("rowheader").allTextContents()).toEqual(["가상가", "가상나"]);
  },
);

test.each(["light", "dark"])("cards keep controlled sorting in %s, including keyboard and rotation", async theme => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test`);
  await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
  await page.locator('[role="grid"][data-layout="cards"]').waitFor();
  const sort = page.getByRole("combobox", { name: "정렬", exact: true });
  await sort.waitFor();
  expect(await sort.inputValue()).toBe("name");
  expect(await sort.locator("option").allTextContents()).toEqual(["이름", "메모"]);
  await sort.selectOption("note");
  await page.getByText("note:ascending", { exact: true }).waitFor();
  await page.getByRole("button", { name: "내림차순", exact: true }).click();
  await page.getByText("note:descending", { exact: true }).waitFor();
  const ascending = page.getByRole("button", { name: "오름차순", exact: true });
  await ascending.focus();
  await ascending.press("Enter");
  await page.getByText("note:ascending", { exact: true }).waitFor();
  // The caller owns ordering; the table emits the descriptor without sorting a loaded page itself.
  expect(await page.getByRole("rowheader").allTextContents()).toEqual(["가상가메모첫째고정-", "가상나메모둘째고정-"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[role="grid"][data-layout="rows"]').waitFor();
  expect(await sort.count()).toBe(0);
  expect(await page.getByRole("columnheader", { name: "메모", exact: true }).getAttribute("aria-sort")).toBe("ascending");
});

test.each([1440, 390])("without a sort handler no column or card control can sort at %s px", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?readonly`);
  await page.getByText("name:ascending", { exact: true }).waitFor();
  expect(await page.locator("[data-allows-sorting]").count()).toBe(0);
  if (width === 1440) await page.getByRole("columnheader", { name: "이름", exact: true }).click();
  expect(await page.getByText("name:ascending", { exact: true }).isVisible()).toBe(true);
  expect(await page.getByRole("combobox", { name: "정렬", exact: true }).count()).toBe(0);
});

test("a narrow table without card columns keeps header sorting", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?rows`);
  const name = page.getByRole("columnheader", { name: "이름", exact: true });
  await name.click();
  await page.getByText("name:descending", { exact: true }).waitFor();
  expect(await page.getByRole("combobox", { name: "정렬", exact: true }).count()).toBe(0);
});

test.each([1440, 390])("row ids can match column ids while callbacks and selection keep raw ids at %s px", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?collision`);
  const rows = page.getByRole("row").filter({ has: page.getByRole("rowheader") });
  await rows.nth(3).waitFor();
  expect(await rows.count()).toBe(4);
  for (const [i, id] of ["name", "__select", "__card", "row:name"].entries()) {
    const row = rows.nth(i);
    await row.hover();
    expect(await page.locator("body").getAttribute("data-hover")).toBe(id);
    await row.focus();
    expect(await page.locator("body").getAttribute("data-focus")).toBe(id);
    await row.press("o");
    expect(await page.locator("body").getAttribute("data-action")).toBe(id);
    await row.press("Space");
    await page.waitForFunction(() => document.querySelector('[aria-selected="true"]'));
    expect(await row.getAttribute("aria-selected")).toBe("true");
    expect(JSON.parse((await page.locator("body").getAttribute("data-selection"))!)).toContain(id);
  }
  await rows.first().focus();
  await rows.first().press("o");
  await expect.poll(() => page.locator("body").getAttribute("data-action")).toBe("name");
  await rows.first().press("Space");
  await expect.poll(async () => JSON.parse((await page.locator("body").getAttribute("data-selection"))!)).toEqual(["__select", "__card", "row:name"]);
});

test("native row actions receive the caller's id", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?collision-action`);
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "가상0", exact: true }) });
  await row.click();
  await expect.poll(() => page.locator("body").getAttribute("data-action")).toBe("name");
});
