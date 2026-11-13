// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserEngine } from "../lib/browser-test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as expectElement, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/table-test", logLevel: "error",
    optimizeDeps: { include: ["react", "react/jsx-dev-runtime", "react-dom/client"] },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "table-test",
      resolveId: id => id === "/table-test.js" ? "\0table-test" : undefined,
      load: id => id === "\0table-test" ? `
        import { createElement as h, useState, useEffect } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Check } from '/apps/web/src/ui/button/button.tsx';
        import { Card } from '/apps/web/src/ui/card/card.tsx';
        import { Table } from '/apps/web/src/ui/table.tsx';
        import '/apps/web/src/app.css';
        const wideCols = ['Name', 'Entity', 'Current', 'After', 'Notes'].map((header, i) => ({
          header, cell: r => i === 0 ? r.name : 'Long column value that clips on phones ' + i,
        }));
        window.cellMounts = 0;
        function EditCell({ name }) {
          const [editing, setEditing] = useState(false);
          useEffect(() => { window.cellMounts++; }, []);
          return editing ? h('input', { 'aria-label': 'Rename ' + name, defaultValue: name })
            : h('button', { onClick: () => setEditing(true) }, 'Edit ' + name);
        }
        function MobileCases() {
          const [nestedEditor, setNestedEditor] = useState(false);
          window.toggleNestedEditor = setNestedEditor;
          const mode = location.hash.slice(1);
          const item = [{ id: 'MOB-0', name: 'MOB-0' }];
          if (mode === 'stateful' || mode === 'focus' || mode === 'forced-cards') return h('main', null, h(Table, {
            mobileLayout: mode === 'forced-cards' ? 'cards' : undefined,
            label: 'Inline editing', rows: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], rowId: r => r.id, columns: [
              { header: 'Name', cell: r => r.name },
              { header: 'Edit', cell: r => mode !== 'focus' ? h(EditCell, { name: r.name })
                : r.id === 'a' ? (nestedEditor ? h('input', { 'aria-label': 'Nested editor' }) : r.name)
                : h('button', null, 'Keep focus') },
            ],
          }));
          if (mode.startsWith('empty')) return h('main', null, h(Card, { title: 'Permissions', flush: true }, h(Table, { label: 'Empty permissions', rows: [], mobileLayout: mode === 'empty-rows' ? 'rows' : undefined, rowId: r => r.id, columns: [{ header: 'Domain', cell: r => r.name }] })));
          if (mode === 'forced-rows') return h('main', null, h(Table, { label: 'Preview rows', rows: item, rowId: r => r.id, mobileLayout: 'rows', columns: wideCols }));
          if (mode === 'editor') return h('main', null, h(Table, { label: 'Editor', rows: item, rowId: r => r.id, columns: [
            ...wideCols.slice(0, 4), { header: 'Edit', cell: () => h('input', { 'aria-label': 'Editor value', defaultValue: 'Kept' }) },
          ] }));
          if (mode === 'inline-check') return h('main', null, h(Table, { label: 'Inline check', rows: item, rowId: r => r.id, columns: [
            { header: 'Enabled', cell: r => h('input', { type: 'checkbox', 'aria-label': 'Enable ' + r.id }) }, ...wideCols,
          ] }));
          if (mode === 'selection') return h('main', null, h(Table, { label: 'Selection', rows: item, rowId: r => r.id, columns: [
            { header: h(Check, { checked: false, onChange() {}, 'aria-label': 'Select all 1' }, 'Select all 1'), fit: true,
              cell: r => h(Check, { checked: false, onChange() {}, 'aria-label': 'Select ' + r.id }) }, ...wideCols,
          ] }));
          if (mode === 'editable-false') return h('main', null, h(Table, { label: 'Static contenteditable', rows: item, rowId: r => r.id, columns: [
            { header: 'Name', cell: r => h('span', { contentEditable: 'false' }, r.name) }, ...wideCols.slice(1),
          ] }));
          if (mode === 'editable-true') return h('main', null, h(Table, { label: 'Rich editor', rows: item, rowId: r => r.id, columns: [
            { header: 'Name', cell: r => h('span', { contentEditable: 'true', suppressContentEditableWarning: true }, r.name) }, ...wideCols.slice(1),
          ] }));
          return h('main', null, h(Table, { label: 'Dynamic', rows: item, rowId: r => r.id, columns: [
            { header: 'Name', cell: r => h('span', null, nestedEditor ? h('input', { 'aria-label': 'Nested editor', defaultValue: r.name }) : r.name) }, ...wideCols.slice(1),
          ] }));
        }
        function App() {
          if (location.hash) return h(MobileCases);
          const [rows, setRows] = useState([{ id: 'first', name: 'Short', count: '0' }]);
          const [grouped, setGrouped] = useState(false);
          const [selected, setSelected] = useState();
          window.groupRows = () => { window.updateRows(); setGrouped(true); };
          window.updateRows = () => setRows([
            { id: 'first', name: 'Short', count: 'Code issued 12 · Passkey registered 345' },
            { id: 'live', name: 'A much longer tenant name arriving over the stream', count: '123456789' },
          ]);
          return h(Table, { label: 'Tenants', rows, rowId: r => r.id,
            groups: grouped ? [...rows].reverse().map(r => ({ id: r.id, header: r.name, rows: [r] })) : undefined,
            selected, onSelect: grouped ? setSelected : undefined,
            tone: grouped ? () => 'warn' : undefined, detail: grouped ? r => r.id === 'first' ? 'Row details' : null : undefined,
            columns: [
            { header: 'Name', cell: r => r.name },
            { header: 'Accounts', width: 'summary', fit: true, cell: r => r.count },
          ] });
        }
        createRoot(document.getElementById('root')).render(h(App));
      ` : undefined,
      configureServer: vite => {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/table-test") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Table</title><div id="root"></div><script type="module" src="/table-test.js"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

for (const width of [1440, 390]) {
  test(`column definitions preserve geometry when live rows and account counts arrive at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}table-test`);
    const cells = page.locator("tbody tr").first().locator("td");
    await expectElement(cells).toHaveCount(2);
    const geometry = () => cells.evaluateAll(els => els.map(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    }));
    const before = await geometry();
    await page.evaluate(() => (window as unknown as { updateRows: () => void }).updateRows());
    await expectElement(page.locator("tbody tr")).toHaveCount(2);
    expect(await geometry()).toEqual(before);
    expect(await page.locator("table").evaluate(el => getComputedStyle(el).tableLayout)).toBe("fixed");
    expect(await cells.last().evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test("grouped tables preserve row detail, tone and keyboard selection across native bodies", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}table-test`);
  await page.evaluate(() => (window as unknown as { groupRows: () => void }).groupRows());
  await expectElement(page.locator("tbody")).toHaveCount(2);
  await expectElement(page.locator('th[scope="rowgroup"]')).toHaveCount(2);
  await expectElement(page.getByText("Row details")).toBeVisible();
  const first = page.locator('tr[data-id="first"]'), last = page.locator('tr[data-id="live"]');
  await expectElement(first).toHaveAttribute("data-tone", "warn");
  await first.focus();
  await page.keyboard.press("ArrowUp");
  await expectElement(last).toBeFocused();
  await page.keyboard.press("Enter");
  await expectElement(last).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expectElement(first).toBeFocused();
  await first.dispatchEvent("keydown", { key: "ㅏ", code: "KeyK" });
  await expectElement(last).toBeFocused();
  await last.dispatchEvent("keydown", { key: "ㅓ", code: "KeyJ" });
  await expectElement(first).toBeFocused();
});

test("editing tables never add wrapper tab stops or duplicate regions at any width", async () => {
  for (const [hash, label] of [["editor", "Editor"], ["inline-check", "Inline check"], ["editable-true", "Rich editor"]] as const) {
    await page.goto("about:blank");
    await page.goto(`${server.resolvedUrls!.local[0]}table-test#${hash}`);
    const table = page.getByRole("table", { name: label, exact: true });
    const wrapper = table.locator("xpath=..");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await expectElement(table.locator("tbody > tr").first()).toHaveCSS("display", "table-row");
      for (const attr of ["tabindex", "role", "aria-label"]) {
        await expectElement(wrapper).not.toHaveAttribute(attr, /.+/);
        await expectElement(table).not.toHaveAttribute(attr, /.+/);
      }
      await expectElement(page.getByRole("region", { name: label, exact: true })).toHaveCount(0);
    }
  }
});

test("an empty table caption does not create an unfocusable scroll region in a flush card", async () => {
  for (const width of [1440, 390]) for (const mode of ["empty", "empty-rows"]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("about:blank");
    await page.goto(`${server.resolvedUrls!.local[0]}table-test#${mode}`);
    const body = page.getByRole("region", { name: "Permissions", exact: true }).locator("[data-flush]");
    await expectElement(body.getByRole("table", { name: "Empty permissions", exact: true })).toHaveCount(1);
    const overflow = await body.evaluate(el => ({ x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight }));
    expect(overflow).toEqual({ x: 0, y: 0 });
  }
});

test("read-only forced-row tables expose keyboard scroll and a clipping cue only while clipped", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}table-test#forced-rows`);
  const table = page.getByRole("table", { name: "Preview rows", exact: true });
  const scroller = table.locator("xpath=..");
  const cue = page.locator("[data-scroll-cue]");
  for (const attr of ["tabindex", "role", "aria-label"]) await expectElement(scroller).not.toHaveAttribute(attr, /.+/);
  await expectElement(page.getByRole("region", { name: "Preview rows", exact: true })).toHaveCount(0);
  await expectElement(table).toHaveAttribute("tabindex", "0");
  await expectElement(cue).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
  await table.focus();
  await table.press("ArrowRight");
  await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await scroller.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expectElement(cue).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 844 });
  await expectElement(table).not.toHaveAttribute("tabindex", /.+/);
  await expectElement(cue).toHaveCount(0);
});

test("selection cards, contenteditable=false and dynamic nested editors switch between cards and rows", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}table-test#selection`);
  const selection = page.getByRole("table", { name: "Selection", exact: true });
  await expectElement(selection.locator("tbody > tr").first()).toHaveCSS("display", "grid");
  const selectAllLabel = selection.getByText("Select all 1", { exact: true });
  await expectElement(selectAllLabel).toBeVisible();
  const labelBox = await selectAllLabel.boundingBox();
  expect(labelBox!.width).toBeGreaterThan(labelBox!.height * 2);
  const hiddenHead = await selection.getByRole("columnheader", { name: "Name", exact: true }).boundingBox();
  expect(Math.max(hiddenHead!.width, hiddenHead!.height)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 844 });
  const desktopLabel = await selectAllLabel.boundingBox();
  expect(Math.max(desktopLabel!.width, desktopLabel!.height)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}table-test#editable-false`);
  await expectElement(page.getByRole("table", { name: "Static contenteditable", exact: true }).locator("tbody > tr").first()).toHaveCSS("display", "grid");

  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}table-test#dynamic`);
  const dynamic = page.getByRole("table", { name: "Dynamic", exact: true });
  await expectElement(dynamic.locator("tbody > tr").first()).toHaveCSS("display", "grid");
  await page.evaluate(() => (window as unknown as { toggleNestedEditor: (on: boolean) => void }).toggleNestedEditor(true));
  await expectElement(dynamic.locator("tbody > tr").first()).toHaveCSS("display", "table-row");
  await page.evaluate(() => (window as unknown as { toggleNestedEditor: (on: boolean) => void }).toggleNestedEditor(false));
  await expectElement(dynamic.locator("tbody > tr").first()).toHaveCSS("display", "grid");
});

test("explicit card layout keeps inline editors visible without remounting them", async () => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("about:blank");
    await page.goto(`${server.resolvedUrls!.local[0]}table-test#forced-cards`);
    await page.getByRole("button", { name: "Edit A", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Rename A", exact: true });
    await editor.fill("Renamed");
    await expectElement(page.locator("tbody > tr").first()).toHaveCSS("display", width === 390 ? "grid" : "table-row");
    await expectElement(editor).toBeFocused();
    await expectElement(editor).toHaveValue("Renamed");
    expect(await page.evaluate(() => (window as unknown as { cellMounts: number }).cellMounts)).toBe(2);
  }
});

for (const width of [1440, 390]) {
  test(`stateful cells stay mounted when an inline editor opens at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("about:blank");
    await page.goto(`${server.resolvedUrls!.local[0]}table-test#stateful`);
    await page.getByRole("button", { name: "Edit A", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Rename A", exact: true });
    await expectElement(editor).toBeVisible();
    await editor.fill("Renamed");
    await expectElement(editor).toBeFocused();
    await expectElement(editor).toHaveValue("Renamed");
    expect(await page.evaluate(() => (window as unknown as { cellMounts: number }).cellMounts)).toBe(2);
  });

  test(`focus survives editors appearing and disappearing in another row at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("about:blank");
    await page.goto(`${server.resolvedUrls!.local[0]}table-test#focus`);
    const button = page.getByRole("button", { name: "Keep focus", exact: true });
    const editor = page.getByRole("textbox", { name: "Nested editor", exact: true });
    for (const show of [true, false]) {
      await button.focus();
      await page.evaluate(on => (window as unknown as { toggleNestedEditor: (on: boolean) => void }).toggleNestedEditor(on), show);
      await expectElement(editor).toHaveCount(show ? 1 : 0);
      await expectElement(page.locator("tbody > tr").first()).toHaveCSS("display", width === 390 && !show ? "grid" : "table-row");
      await expectElement(button).toBeFocused();
    }
  });
}
