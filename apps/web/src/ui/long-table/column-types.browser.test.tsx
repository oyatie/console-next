// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as visible } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";
import type { KeysetCursor, ListPage } from "./paging";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const types = ["text", "num", "money", "pct", "date", "time", "duration", "code", "status", "action"];
const numeric = new Set(["num", "money", "pct", "time", "duration", "action"]);

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/column-types-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "column-types-test",
      resolveId: id => id === "/columns.js" ? "\0columns" : undefined,
      load: id => id === "\0columns" ? `
        import {createElement as h, useEffect, useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import {Table} from '/apps/web/src/ui/table.tsx';
        import {LongTable} from '/apps/web/src/ui/long-table/long-table.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const params = new URLSearchParams(location.search);
        const rows = Array.from({length: params.get('total') === '0' ? 0 : params.has('large') ? 2000 : 1}, (_, i) => ({id: String(i), row_index: Number(params.get('offset') || 0) + i + 1}));
        const types = ${JSON.stringify(types)};
        const columns = types.map(type => ({id: type, type, header: type, rowHeader: type === 'text',
          card: params.has('cards') && type === 'text' ? 'title' : undefined,
          cell: r => type === 'text' ? '가상직원'.repeat(7) : type === 'code' ? 'SYN-' + r.id : '123'}));
        if (params.has('override')) columns[7].width = params.has('long') ? '20%' : 'summary';
        const props = {
          label: 'Columns', rows, columns, rowId: r => r.id, density: params.get('density') || 'regular',
          hasMore: params.has('more'), onLoadMore() {}, empty: 'Empty',
          total: params.has('omit-total') ? undefined : params.has('total') ? Number(params.get('total')) : null, rowIndex: r => r.row_index
        };
        function Paged() {
          const [result, setResult] = useState({items: [], total: null, next_cursor: null});
          const load = async cursor => {
            const query = new URLSearchParams({limit: '2'});
            if (cursor) query.set('cursor', JSON.stringify(cursor));
            const next = await fetch('/api/table-contract?' + query).then(r => r.json());
            setResult(old => ({...next, items: [...old.items, ...next.items]}));
          };
          useEffect(() => { load(null); }, []);
          return h(LongTable, {...props, rows: result.items, total: result.total,
            hasMore: result.next_cursor !== null, onLoadMore: () => load(result.next_cursor)});
        }
        createRoot(document.getElementById('root')).render(params.has('paged') ? h(Paged) : h(params.has('long') ? LongTable : Table, props));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/columns") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Columns</title><div id="root"></div><script type="module" src="/columns.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

async function open(query: string, width = 1440, theme = "light") {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}columns?${query}`);
  await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
  await visible(page.locator('table, [role="grid"]').last()).toBeAttached();
  if (!query.includes("cards")) await visible(page.getByRole("columnheader", { name: "num", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const long of [false, true]) for (const theme of ["light", "dark"]) {
  test(`${long ? "virtual" : "native"} column types align headers and values in ${theme}`, async () => {
    await open(long ? "long" : "", 1440, theme);
    for (const type of types) {
      const header = page.getByRole("columnheader", { name: type, exact: true });
      const index = types.indexOf(type);
      const cell = long ? page.locator('[role="row"][data-key]').first().locator('[role="gridcell"], [role="rowheader"]').nth(index) : page.locator("tbody tr").first().locator("td, th").nth(index);
      for (const element of [header, cell]) {
        const style = await element.evaluate(el => {
          const s = getComputedStyle(el);
          return { align: s.textAlign, figures: s.fontVariantNumeric, font: s.fontFamily };
        });
        expect(style.align, type).toBe(numeric.has(type) ? "end" : "start");
        expect(style.figures, type).toContain("tabular-nums");
        if (type === "code" && element === cell) expect(style.font).toContain("monospace");
      }
    }
    if (!long) {
      await visible(page.locator("caption")).toHaveText("Columns");
      await visible(page.locator("table")).not.toHaveAttribute("aria-label");
      expect(await page.locator("table").evaluate(el => getComputedStyle(el).tableLayout)).toBe("fixed");
      await visible(page.locator("colgroup col")).toHaveCount(types.length);
      await visible(page.locator("thead th[scope=col]")).toHaveCount(types.length);
    }
  });
}

test("native and virtual tables use the same width presets and preserve explicit widths", async () => {
  await open("");
  const sizes = () => page.getByRole("columnheader").evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
  const native = await sizes();
  expect(native[2]).toBeGreaterThan(native[1]!);
  await open("long");
  const virtual = await sizes();
  for (let i = 1; i < types.length; i++) expect(Math.abs(virtual[i]! - native[i]!), JSON.stringify({ native, virtual })).toBeLessThanOrEqual(1);
  for (const query of ["override", "long&override"]) {
    await open(query);
    const widths = await sizes();
    expect(widths[7]! / widths.reduce((sum, n) => sum + n, 0)).toBeCloseTo(0.2, 2);
  }
});

for (const long of [false, true]) test(`${long ? "virtual" : "native"} names use the shared budget and expose the full value at 1280px`, async () => {
  await open(long ? "long&large&density=compact" : "density=compact", 1280);
  const headers = page.getByRole("columnheader");
  const widths = await headers.evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
  const share = widths[0]! / widths.reduce((sum, n) => sum + n, 0);
  expect(share).toBeGreaterThan(0.2);
  expect(share).toBeLessThanOrEqual(0.3);
  const name = long ? page.getByRole("rowheader").first() : page.locator('td[data-type="text"]').first();
  await name.hover();
  await visible(name).toHaveAttribute("title", "가상직원".repeat(7));
  if (long) { await name.focus(); await visible(name).toBeFocused(); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("server totals and positions describe the full result, including unknown totals", async () => {
  for (const [query, count] of [["total=2000", "2001"], ["", "-1"]]) {
    await open(`long&offset=100&${query}`);
    await visible(page.getByRole("grid")).toHaveAttribute("aria-rowcount", count!);
    await visible(page.locator('[role="row"][data-key]').first()).toHaveAttribute("aria-rowindex", "102");
  }
  await open("long&total=0");
  await visible(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
  await visible(page.locator('[role="row"][data-key]')).toHaveCount(0);
});

test("omitted totals count all loaded rows only when paging is complete", async () => {
  for (const [query, count] of [["", "2"], ["large", "2001"], ["more", "-1"]]) {
    await open(`long&omit-total&${query}`);
    await visible(page.getByRole("grid")).toHaveAttribute("aria-rowcount", count!);
  }
});

test("keyset pages keep duplicate sort values, and hidden rows never enter totals or positions", async () => {
  const requests: Array<{ cursor: KeysetCursor | null; limit: number }> = [];
  const source = ["a", "b", "hidden", "c", "d"].map(id => ({ id, name: "동명이인" }));
  await page.route("**/api/table-contract?*", route => {
    const query = new URL(route.request().url()).searchParams;
    const cursor = JSON.parse(query.get("cursor") ?? "null") as KeysetCursor | null;
    const limit = Number(query.get("limit"));
    requests.push({ cursor, limit });
    // The mock server's authorized result is filtered before it assigns positions or counts.
    const authorized = source.filter(row => row.id !== "hidden");
    const start = cursor ? authorized.findIndex(row => row.id === cursor.id && row.name === cursor.value) + 1 : 0;
    const items = authorized.slice(start, start + limit).map((row, index) => ({ ...row, row_index: start + index + 1 }));
    const last = items.at(-1)!;
    const result: ListPage<{ id: string; name: string }> = {
      items, total: authorized.length,
      next_cursor: start + items.length < authorized.length ? { value: last.name, id: last.id } : null,
    };
    return route.fulfill({ json: result });
  });
  try {
    await open("long&paged");
    await visible(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "5");
    const rows = page.locator('[role="row"][data-key]');
    await visible(rows).toHaveCount(4);
    expect(await rows.evaluateAll(els => els.map(el => el.getAttribute("data-row-id")))).toEqual(["a", "b", "c", "d"]);
    expect(await rows.evaluateAll(els => els.map(el => el.getAttribute("aria-rowindex")))).toEqual(["2", "3", "4", "5"]);
    expect(requests).toEqual([{ cursor: null, limit: 2 }, { cursor: { value: "동명이인", id: "b" }, limit: 2 }]);
  } finally { await page.unroute("**/api/table-contract?*"); }
});

for (const theme of ["light", "dark"]) test(`typed compact cards preserve row interaction at 390px in ${theme}`, async () => {
  for (const query of ["cards&density=compact", "long&cards&density=compact"]) {
    await open(query, 390, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await visible(page.getByText("가상직원".repeat(7), { exact: true })).toBeVisible();
  }
});

test("typed compact virtual rows stay bounded at 2,000 rows", async () => {
  await open("long&large&density=compact");
  const rows = page.locator('[role="row"][data-key]:visible');
  await visible(rows.first().locator('[role="gridcell"]')).toHaveCount(types.length - 1);
  await visible(rows.first().locator('[role="gridcell"]').first()).toHaveCSS("height", "32px");
  expect(await rows.count()).toBeLessThanOrEqual(40);
  expect(await rows.count()).toBeGreaterThan(1);
});
