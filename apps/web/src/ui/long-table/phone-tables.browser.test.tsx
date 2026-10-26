// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect as visible, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/phone-tables", logLevel: "error",
    define: { "process.env.VIRT_ON": JSON.stringify("1") },
    resolve: { dedupe: ["react", "react-dom"] },
    optimizeDeps: { include: ["react", "react/jsx-runtime", "react-dom/client", "react-aria-components", "intl-messageformat", "@tanstack/react-query"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "phone-tables-test",
      resolveId: (id) => id === "/phone-tables.js" ? "\0phone-tables" : undefined,
      load: (id) => id === "\0phone-tables" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { Table } from '/apps/web/src/ui/table.tsx';
        import { LongTable } from '/apps/web/src/ui/long-table/long-table.tsx';
        import { NO_SELECTION } from '/apps/web/src/ui/long-table/selection.ts';
        import { RosterTable } from '/apps/web/src/features/people/ui/roster-table.tsx';
        import { OPTIONAL_COLUMNS } from '/apps/web/src/features/people/domain/columns.ts';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import '/apps/web/src/app.css';
        await loadCatalog('en');
        const client = new QueryClient({defaultOptions: {queries: {enabled: false}}});
        const rows = Array.from({length: 100}, (_, i) => ({id: 'MOB-' + i}));
        const columns = [
          {id: 'name', header: 'Name', rowHeader: true, cell: r => r.id, width: 120},
          {id: 'status', header: 'Status', card: 'status', cell: () => 'Active', width: 100},
          ...['Unit', 'Position', 'Hired', 'Extra'].map(id => ({id, header: id, cell: () => 'Long unbroken value '.repeat(4), width: 160})),
          {id: 'action', header: 'Action', card: 'action', cell: r => h('button', {onClick: () => document.getElementById('action').textContent = r.id}, 'Open ' + r.id), width: 120}
        ];
        const pagedRows = Array.from({length: 2000}, (_, i) => ({id: 'PAGE-' + i}));
        function Paged() {
          const [loaded, setLoaded] = useState(100);
          const [loadingMore, setLoadingMore] = useState(false);
          const rowMode = location.hash === '#paged-rows';
          const pagedColumns = columns.slice(0, -1).map(({card, ...column}) => ({...column,
            ...(rowMode ? {} : {card}), cell: r => column.id === 'name' ? r.id : 'A fictional department and position'}));
          return h('main', {'data-loaded': loaded, 'data-loading': loadingMore}, h('h1', null, 'Paged people'),
            h(LongTable, {label: 'Paged', rows: pagedRows.slice(0, loaded), columns: pagedColumns, rowId: r => r.id,
              density: location.hash === '#paged-compact' ? 'compact' : 'regular',
              hasMore: loaded < pagedRows.length, loadingMore, empty: 'Empty', onLoadMore() {
                if (loadingMore) return;
                setLoadingMore(true);
                setTimeout(() => {setLoaded(n => Math.min(n + 100, pagedRows.length)); setLoadingMore(false);}, 150);
              }}));
        }
        function App() {
          const [selected, select] = useState('');
          const [selection, setSelection] = useState(NO_SELECTION);
          const [open, setOpen] = useState('');
          if (location.hash.startsWith('#paged')) return h(Paged);
          if (location.hash === '#uncontained') return h('main', null,
            h('h1', null, 'Tables without cards'),
            ...['short', 'long'].map(kind => h('div', {id: kind + '-flex', style: {display: 'flex', containerType: 'inline-size', containerName: 'list-table'}},
              kind === 'short' ? h(Table, {label: 'Uncontained short', rows: rows.slice(0, 3), columns: columns.map(({card, ...c}) => ({...c, width: innerWidth / columns.length})), rowId: r => r.id})
              : h(LongTable, {label: 'Uncontained long', rows: rows.slice(0, 3), columns: columns.map(({card, ...c}) => ({...c, width: innerWidth / columns.length})), rowId: r => r.id, hasMore: false, onLoadMore() {}, empty: 'Empty'}))));
          if (location.hash === '#editor') return h('main', null, h('h1', null, 'Editor'), h(Table, {
            label: 'Editor', rows: rows.slice(0, 1), rowId: r => r.id,
            columns: columns.map(({card, ...column}) => ({...column, cell: r => column.id === 'Extra'
              ? h('input', {'aria-label': 'Editor value', value: 'Kept', readOnly: true}) : column.cell(r)}))}));
          if (location.hash === '#roster') return h(QueryClientProvider, {client}, h('main', null,
            h('h1', null, 'People roster'), h(RosterTable, {label: 'Roster', today: '2026-01-01', density: 'compact', shown: OPTIONAL_COLUMNS,
              rows: [{id: 'roster-0', employee_number: 'MOB-ROSTER', name: '박모바일', company: '가상상사', org_unit: '아주긴가상지점소속부서', position: '사원', employment_type: 'REGULAR', status: 'ON_LEAVE', hire_date: '2025-01-01'}],
              hasMore: false, onLoadMore() {}, empty: 'Empty', selection, onSelectionChange: setSelection})));
          return h('main', null,
            h('h1', null, 'Phone tables'),
            h('div', {id: 'container'},
              h(Table, {label: 'Short', rows: rows.slice(0, 2), columns, rowId: r => r.id, selected, onSelect: select,
                detail: r => r.id === selected && h('span', null, 'Detail ' + r.id)}),
              h(LongTable, {label: 'Long', rows, columns, rowId: r => r.id, hasMore: false, onLoadMore() {}, empty: 'Empty',
                selection, onSelectionChange: setSelection, onRowAction: setOpen, rowKeys: {}})),
            h('output', {id: 'action'}, selected), h('output', {id: 'open'}, open));
        }
        createRoot(document.getElementById('root')).render(h(App));
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/phone-tables") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone tables</title><div id="root"></div><script type="module" src="/phone-tables.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

test("390px cards expose identifiers, status, labelled facts and actions without overflow; axe passes", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables`);
  const short = page.getByRole("grid", { name: "Short", exact: true });
  const long = page.getByRole("grid", { name: "Long", exact: true });
  await visible(short.getByRole("row").filter({ hasText: "MOB-0" })).toHaveCSS("display", "grid");
  await visible(long).toHaveAttribute("data-layout", "cards");
  for (const table of [short, long]) {
    const row = table.getByRole("row").filter({ hasText: "MOB-0" });
    await visible(row.getByText("MOB-0", { exact: true })).toBeVisible();
    await visible(row.getByText("Active", { exact: true })).toBeVisible();
    if (table === short) {
      await visible(row.locator('[data-label="Unit"]')).toBeVisible();
      expect(await row.locator('[data-label="Unit"]').evaluate(el => getComputedStyle(el, "::before").content)).toBe('"Unit"');
    } else await visible(row.getByText("Unit", { exact: true })).toBeVisible();
    if (table === short) {
      const omitted = row.locator('[data-card="omit"]');
      await visible(omitted).toHaveCount(1);
      await visible(omitted).toBeHidden();
      await visible(row).toHaveCSS("grid-template-columns", /^(\d+(?:\.\d+)?px) \1$/);
    } else {
      await visible(row.locator("dt")).toHaveCount(3);
      const facts = row.locator("dl");
      await visible(facts).toHaveCSS("grid-template-columns", /^(\d+(?:\.\d+)?px) \1$/);
      await visible(row.getByRole("rowheader", { name: "MOB-0", exact: true })).toBeVisible();
      await visible(async () => {
        const size = await row.getByRole("rowheader").evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight }));
        expect(size.height).toBeGreaterThanOrEqual(size.content);
      }).toPass();
    }
    await row.getByRole("button", { name: "Open MOB-0", exact: true }).press("Enter");
    await visible(page.locator("#action")).toHaveText("MOB-0");
  }
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  }
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables#editor`);
  const editor = page.getByRole("table", { name: "Editor", exact: true });
  await visible(editor.getByRole("row").last()).toHaveCSS("display", "table-row");
  await visible(editor.getByRole("textbox", { name: "Editor value" })).toBeVisible();
}, 30_000);

test.each(["cards", "compact", "rows"])("paged 2,000-row %s at 390px never leave the viewport blank after loading", async (mode) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables#paged-${mode}`);
  const grid = page.getByRole("grid", { name: "Paged", exact: true });
  await visible(grid).toHaveAttribute("data-layout", mode === "rows" ? "rows" : "cards");
  await visible(grid.getByRole("rowheader", { name: "PAGE-0", exact: true })).toBeVisible();
  const blanks: number[] = [];
  for (let step = 0; step < 60; step++) {
    // Let the page commit, then sample 300 ms later without another scroll or assertion retry.
    const inView = await grid.evaluate(async (el) => {
      const main = el.closest("main")!;
      const loaded = main.getAttribute("data-loaded");
      await new Promise<void>((done) => {
        const finish = () => { observer.disconnect(); clearTimeout(idle); done(); };
        const observer = new MutationObserver(() => {
          if (main.getAttribute("data-loaded") !== loaded && main.getAttribute("data-loading") === "false") finish();
        });
        const idle = setTimeout(() => {
          if (main.getAttribute("data-loading") === "false") finish();
        }, 200);
        observer.observe(main, { attributes: true });
        el.scrollTop = el.scrollHeight;
      });
      await new Promise(done => setTimeout(done, 300));
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('[role="rowheader"]')].filter(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      }).length;
    });
    if (inView === 0) blanks.push(step);
  }
  expect(blanks).toEqual([]);
  await visible(page.locator("main")).toHaveAttribute("data-loaded", "2000");
  if (mode !== "rows") {
    const row = grid.getByRole("rowheader").first();
    const height = await row.evaluate(el => el.getBoundingClientRect().height);
    await page.setViewportSize({ width: 260, height: 844 });
    await visible(async () => {
      const resized = await row.evaluate(el => el.getBoundingClientRect().height);
      expect(resized).toBeGreaterThan(height);
      // Most cards are still unmeasured: their estimate must follow the new wrapping height.
      expect(await grid.evaluate(el => el.scrollHeight)).toBeGreaterThan(resized * 2000 * 0.85);
    }).toPass();
  }
}, 60_000);

test("container boundary, virtualization and keyboard state survive card/row changes; desktop widths return", async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables`);
  const long = page.getByRole("grid", { name: "Long", exact: true });
  await visible(long.getByRole("rowheader", { name: "MOB-0", exact: true })).toBeVisible();
  const widths = await long.getByRole("columnheader").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
  // Near miss: the viewport stays wide; only the table's container crosses the boundary.
  await page.locator("#container").evaluate(el => el.style.width = "481px");
  await visible(long).toHaveAttribute("aria-colcount", String(widths.length));
  await page.locator("#container").evaluate(el => el.style.width = "480px");
  await visible(long.getByRole("columnheader")).toHaveCount(2);
  await visible(long).toHaveAttribute("data-layout", "cards");
  const row = long.getByRole("row").filter({ hasText: "MOB-0" });
  await row.focus();
  await row.press("Space");
  await visible(row).toHaveAttribute("aria-selected", "true");
  await visible(row).toBeFocused();
  await visible(row).toHaveAttribute("data-key", "MOB-0");
  await row.press("Enter");
  await visible(page.locator("#open")).toHaveText("MOB-0");
  expect(await long.getByRole("row").count()).toBeLessThan(30);
  await page.locator("#container").evaluate(el => el.style.removeProperty("width"));
  await visible(long).toHaveAttribute("data-layout", "rows");
  await visible(row).toHaveAttribute("aria-selected", "true");
  await visible(row).toBeFocused();
  expect(await long.getByRole("columnheader").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width))).toEqual(widths);
}, 30_000);

test("the product roster renders both identifiers, status and its first three facts at 390px", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables#roster`);
  const roster = page.getByRole("grid", { name: "Roster", exact: true });
  await visible(roster.getByRole("columnheader")).toHaveCount(2);
  await visible(roster).toHaveAttribute("data-layout", "cards");
  const row = roster.getByRole("row").filter({ hasText: "MOB-ROSTER" });
  await visible(row.getByText("MOB-ROSTER", { exact: true })).toBeVisible();
  await visible(row.getByRole("rowheader", { name: "박모바일", exact: true })).toBeVisible();
  await visible(row.getByText(/가상상사/)).toBeVisible();
  await visible(row.locator("dt")).toHaveCount(3);
  await visible(row.locator(".chip")).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
}, 30_000);


test.each(["short", "long"])("%s without card columns retains its width and row layout in a flex parent", async (kind) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("about:blank");
    await page.goto(`${server.resolvedUrls!.local[0]}phone-tables#uncontained`);
    const short = page.getByRole("table", { name: "Uncontained short", exact: true });
    const long = page.getByRole("grid", { name: "Uncontained long", exact: true });
    const flex = page.locator(`#${kind}-flex`);
    const child = flex.locator(":scope > *");
    expect(await child.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(width);
    await visible(child).toHaveCSS("container-type", "normal");
    await visible(short.locator("tbody > tr").first()).toHaveCSS("display", "table-row");
    await visible(long).toHaveAttribute("data-layout", "rows");
    await visible(long).toHaveAttribute("aria-colcount", "7");
    const cell = long.getByRole("rowheader", { name: "MOB-0", exact: true });
    await visible(cell).toHaveCSS("height", "40px");
    await long.locator("xpath=ancestor::section").evaluate(el => el.setAttribute("data-density", "compact"));
    await visible(cell).toHaveCSS("height", "32px");
  }
}, 30_000);
