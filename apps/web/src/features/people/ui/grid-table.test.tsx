import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadCatalog } from "@console/i18n";
import { GridTable, type GridRow } from "./grid-table";
import type { GridField } from "../domain/grid";

const columns: readonly GridField[] = [
  { key: "sex", kind: "sex", cls: "now" },
  { key: "address", kind: "address", cls: "now" },
  { key: "job", kind: "text", cls: "now" },
];
const rows2000: readonly GridRow[] = Array.from({ length: 2000 }, (_, i) => ({
  id: `emp-${i + 1}`, number: String(i + 1).padStart(4, "0"), name: `Person ${i + 1} 직원 😀`,
  current: ["MALE", "Seoul", "Developer"], typed: [undefined, undefined, undefined],
  cells: [{ keep: true }, { keep: true }, { keep: true }],
}));

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let errors: string[];

beforeAll(async () => {
  await loadCatalog("en");
  // Mount the real component and GridPage styles; no backend or server-rendered event simulation.
  const entry = `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { loadCatalog } from '@console/i18n';
    import { GridTable } from '/apps/web/src/features/people/ui/grid-table';
    import s from '/apps/web/src/features/people/ui/grid-page.module.css';
    import '/apps/web/src/app.css';
    await loadCatalog('en');
    function Fixture() {
      const [rows, setRows] = useState(${JSON.stringify(rows2000)});
      const bounded = new URLSearchParams(location.search).has('bounded');
      return <div className={s.page}>
        <header style={{height: 240, flexShrink: 0}}><button onClick={() => setRows([])}>Filter empty</button></header>
        <div id="scroller" className={s.gridWrap} style={bounded ? {height: 600, flexShrink: 0} : undefined}>
          <GridTable rows={rows} columns={${JSON.stringify(columns)}} label="People grid"
            onCell={(id, col, text) => setRows(rows => rows.map(row => row.id === id ? {...row, typed: row.typed.map((value, i) => i === col ? text : value)} : row))}
            statusOf={() => ({tone: 'same', text: 'Same'})}
            fieldLabel={f => f.key} suggestionOf={() => undefined} />
        </div><button id="after">After grid</button>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `;
  server = await createServer({
    configFile: false, root: process.cwd(), cacheDir: ".cache/grid-table-test-vite",
    plugins: [react(), {
      name: "grid-table-test-fixture",
      resolveId: (id) => id === "/__grid-test.tsx" ? id : undefined,
      load: (id) => id === "/__grid-test.tsx" ? entry : undefined,
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__grid-test") return next();
          void vite.transformIndexHtml("/__grid-test", '<!doctype html><html><body><div id="root"></div><script type="module" src="/__grid-test.tsx"></script></body></html>')
            .then((html) => { res.setHeader("Content-Type", "text/html"); res.end(html); }).catch(next);
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd(), dirname(realpathSync(resolve("node_modules/pretendard")))] } },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
});
afterEach(async () => {
  await page?.close();
  expect(errors).toEqual([]);
});

async function mount(bounded = false) {
  await page.goto(`${server.resolvedUrls!.local[0]}__grid-test${bounded ? "?bounded" : ""}`);
  await page.getByRole("grid").waitFor();
}

async function expectWindowAt(row: number) {
  await expect.poll(() => page.getByRole("rowheader").allTextContents()).toContain(String(row));
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
  // Check geometry, not just DOM presence: the rendered rows must cover the viewport.
  const coverage = await page.evaluate(() => {
    const wrapper = document.getElementById("scroller")!;
    const bounds = wrapper.getBoundingClientRect();
    const top = Math.max(0, bounds.top + wrapper.clientTop);
    const bottom = Math.min(innerHeight, bounds.top + wrapper.clientTop + wrapper.clientHeight);
    const cells = [...document.querySelectorAll('[role="rowheader"]')];
    const first = cells[0]!.getBoundingClientRect();
    const last = cells.at(-1)!.getBoundingClientRect();
    return { coversTop: first.top <= top, coversBottom: last.bottom >= bottom, visible: cells.some((cell) => {
      const rect = cell.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom;
    }) };
  });
  expect(coverage).toEqual({ coversTop: true, coversBottom: true, visible: true });
}

test("component test at 2,000 rows: rendered row elements <= visible + overscan", async () => {
  const markup = renderToStaticMarkup(<GridTable rows={rows2000} columns={columns} label="People grid"
    onCell={() => undefined} statusOf={() => ({ tone: "same", text: "Same" })}
    fieldLabel={(f) => f.key} suggestionOf={() => undefined} />);
  expect((markup.match(/role="row"/g) ?? []).length - 1).toBeLessThanOrEqual(25 + 10);
  await mount();
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});

test("document scrolling renders the visible rows with the GridPage wrapper", async () => {
  await mount();
  await page.evaluate(() => window.scrollTo(0, 7200));
  await expectWindowAt(200);
  await page.evaluate(() => window.scrollTo(0, 36000));
  await expectWindowAt(1000);
});

test("focused row does not pin rendering during parent scrolling", async () => {
  await mount(true);
  await page.locator("#grid-0-0").focus();
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 36000; });
  await expectWindowAt(1000);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 7200; });
  await expectWindowAt(200);
});

test("scrolling an edited cell out of view keeps its draft", async () => {
  await mount(true);
  await page.locator("#grid-0-2").focus();
  await page.keyboard.press("F2");
  await page.locator("#grid-0-2 input").fill("Updated draft");
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 36000; });
  await expectWindowAt(1000);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(() => page.locator("#grid-0-2").textContent()).toBe("Updated draft");
});

for (const bounded of [false, true]) {
  test(`keyboard navigation reaches row 2000 (${bounded ? "parent" : "document"} scrolling)`, async () => {
    await mount(bounded);
    await page.getByRole("grid").focus();
    await page.keyboard.press("Control+End");
    await expect.poll(() => page.locator("#grid-1999-2 input").evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
    expect(await page.locator("#grid-0-0").count()).toBe(0);
    await expect.poll(() => page.locator("#grid-1999-2").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const wrapper = document.getElementById("scroller")!.getBoundingClientRect();
      return rect.bottom <= Math.min(innerHeight, wrapper.bottom) && rect.top >= Math.max(0, wrapper.top);
    })).toBe(true);
    await page.keyboard.press("Control+Home");
    await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.locator("#grid-1999-0").count()).toBe(0);
  });
}

test("keyboard navigation moves row by row and page by page", async () => {
  await mount(true);
  await page.locator("#grid-0-0").focus();
  for (const [key, row] of [["ArrowDown", 1], ["PageDown", 26], ["PageUp", 1]] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => page.locator(`#grid-${row}-0 input`).evaluate((el) => el === document.activeElement)).toBe(true);
  }
});

test("Tab and navigation on a filtered-empty grid do not throw", async () => {
  await mount();
  await page.locator("#grid-0-0").focus();
  await page.getByRole("button", { name: "Filter empty" }).click();
  expect(await page.getByRole("rowheader").count()).toBe(0);
  await page.getByRole("grid").focus();
  for (const key of ["ArrowDown", "Control+End", "Enter", "F2", "Delete", "F8", "Tab"]) await page.keyboard.press(key);
  expect(await page.locator("#after").evaluate((el) => el === document.activeElement)).toBe(true);
});
