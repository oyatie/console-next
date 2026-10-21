// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GridTable, type GridRow } from "./grid-table";
import type { GridField } from "../domain/grid";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadCatalog } from "@console/i18n";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let errors: string[];

function setupGridFixture(rows2000: readonly GridRow[], columns: readonly GridField[]) {
  beforeAll(async () => {
    await loadCatalog("en");
    // Mount the real component and GridPage styles; no backend or server-rendered event simulation.
    const entry = `
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { i18n, loadCatalog } from '@console/i18n';
      import { GridTable } from '/apps/web/src/features/people/ui/grid-table';
      import s from '/apps/web/src/features/people/ui/grid-page.module.css';
      import '/apps/web/src/app.css';
      await loadCatalog('en');
      i18n.set('en');
      function Fixture() {
        const [rows, setRows] = useState(${JSON.stringify(rows2000)});
        const [activeCell, setActiveCell] = useState(null);
        const [activeChanges, setActiveChanges] = useState(0);
        const bounded = new URLSearchParams(location.search).has('bounded');
        return <div className={s.page} style={bounded ? undefined : {height: 'auto'}}>
          <header style={{height: 240, flexShrink: 0}}><button onClick={() => setRows([])}>Filter empty</button></header>
          <div id="scroller" className={s.gridWrap} style={bounded ? undefined : {flex: 'none'}}>
            <GridTable rows={rows} columns={${JSON.stringify(columns)}} label="People grid"
              activeCell={activeCell} onActiveChange={at => {setActiveCell(at); setActiveChanges(n => n + 1);}}
              onCell={(id, col, text) => setRows(rows => rows.map(row => row.id === id ? {...row, typed: row.typed.map((value, i) => i === col ? text : value)} : row))}
              statusOf={() => ({tone: 'same', text: 'Same'})}
              fieldLabel={f => f.key} suggestionOf={() => undefined} />
          </div><button id="after" data-active={JSON.stringify(activeCell)} data-active-changes={activeChanges}>After grid</button>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `;
    server = await createServer({
      configFile: false, root: process.cwd(), cacheDir: ".cache/grid-table-test-vite",
      plugins: [react(), {
        name: "grid-table-test-fixture",
        enforce: "pre",
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
    // Load the virtual entry's dependencies before timing individual interactions.
    const warmup = await browser.newPage();
    try {
      await warmup.goto(`${server.resolvedUrls!.local[0]}__grid-test`);
      await warmup.getByRole("grid").waitFor();
    } finally {
      await warmup.close();
    }
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
}

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

export { page, server, setupGridFixture, mount, expectWindowAt };

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

setupGridFixture(rows2000, columns);

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
  await page.evaluate(() => window.scrollTo(0, 8000));
  await expectWindowAt(200);
  await page.evaluate(() => window.scrollTo(0, 40000));
  await expectWindowAt(1000);
});

test("focused row does not pin rendering during parent scrolling", async () => {
  await mount(true);
  await page.locator("#grid-0-0").focus();
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 40000; });
  await expectWindowAt(1000);
  expect(await page.getByRole("grid").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.locator("#grid-1-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 8000; });
  await expectWindowAt(200);
});

test("scrolling an edited cell out of view keeps its draft", async () => {
  await mount(true);
  await page.locator("#grid-0-2").focus();
  await page.keyboard.press("F2");
  await page.locator("#grid-0-2 input").fill("Updated draft");
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 40000; });
  await expectWindowAt(1000);
  expect(await page.getByRole("grid").evaluate((el) => el === document.activeElement)).toBe(true);
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
  const activeChanges = await page.locator("#after").getAttribute("data-active-changes");
  await page.getByRole("button", { name: "Filter empty" }).click();
  expect(await page.getByRole("rowheader").count()).toBe(0);
  await page.getByRole("grid").focus();
  for (const key of ["ArrowDown", "Control+End", "Enter", "F2", "Delete", "F8", "Tab"]) await page.keyboard.press(key);
  expect(await page.locator("#after").evaluate((el) => el === document.activeElement)).toBe(true);
  expect(await page.locator("#after").getAttribute("data-active")).toBe('{"r":0,"c":0}');
  expect(await page.locator("#after").getAttribute("data-active-changes")).toBe(activeChanges);
});

test("End and Home stay in the current row", async () => {
  await mount(true);
  await page.locator("#grid-1-0").click();
  for (const [key, col] of [["End", 2], ["Home", 0]] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe(`grid-1-${col}`);
  }
});

test("virtual rows expose their absolute accessible positions", async () => {
  await mount(true);
  expect(await page.getByRole("row").first().getAttribute("aria-rowindex")).toBe("1");
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+End");
  await expect.poll(() => page.locator("#grid-1999-2").locator("..").getAttribute("aria-rowindex")).toBe("2001");
});

for (const key of ["F2", "Enter", "typing"]) {
  test(`${key} at the grid tab stop accepts Unicode text`, async () => {
    await mount(true);
    await page.getByRole("button", { name: "Filter empty" }).focus();
    await page.keyboard.press("Tab");
    if (key !== "typing") await page.keyboard.press(key);
    await expect.poll(() => page.locator("#grid-0-0 input").count()).toBe(1);
    await page.keyboard.insertText("직원 😀");
    await page.keyboard.press("Enter");
    expect(await page.locator("#grid-0-0").textContent()).toBe("직원 😀");
    expect(await page.locator("#grid-0-0").getAttribute("data-editing")).toBeNull();
    await expect.poll(() => page.locator("#grid-1-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  });
}

test("ArrowDown preserves focus across the render boundary", async () => {
  await mount(true);
  await page.locator("#grid-0-2").click();
  for (let i = 0; i < 70; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-70-2");
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});

for (const bounded of [false, true]) {
  test(`keyboard navigation reveals clipped columns (${bounded ? "parent" : "document"} scrolling)`, async () => {
    await page.setViewportSize({ width: 600, height: 800 });
    await mount(bounded);
    await page.locator("#grid-0-0").click();
    for (const [key, cell] of [["ArrowRight", "grid-0-1"], ["ArrowRight", "grid-0-2"], ["Home", "grid-0-0"], ["Control+End", "grid-1999-2"]] as const) {
      await page.keyboard.press(key);
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe(cell);
      await expect.poll(() => page.locator(`#${cell}`).evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const wrapper = document.getElementById("scroller")!.getBoundingClientRect();
        return rect.left >= Math.max(0, wrapper.left) && rect.right <= Math.min(innerWidth, wrapper.right);
      })).toBe(true);
    }
  });
}

test("Shift+Tab leaves the grid's single tab stop", async () => {
  await mount(true);
  await page.locator("#grid-0-0").focus();
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest('[role="grid"]'))).toBeNull();
  expect(await page.getByRole("button", { name: "Filter empty" }).evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.locator("#after").evaluate((el) => el === document.activeElement)).toBe(true);
});

test("density changes keep virtual spacers aligned with rows", async () => {
  await mount(true);
  for (const [density, height] of [["regular", 40], ["compact", 32], ["regular", 40]] as const) {
    await page.locator("#scroller").evaluate((el, value) => { el.setAttribute("data-density", value); }, density);
    await expect.poll(() => page.getByRole("rowheader").first().evaluate((el) => el.getBoundingClientRect().height)).toBe(height);
    await page.locator("#grid-0-0").focus();
    await page.keyboard.press("Control+End");
    await expect.poll(() => page.locator("#grid-1999-2 input").evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
    await expect.poll(() => page.locator("#grid-1999-2").evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      const wrapper = document.getElementById("scroller")!.getBoundingClientRect();
      return bounds.bottom <= wrapper.bottom && bounds.top >= wrapper.top;
    })).toBe(true);
    await page.locator("#scroller").evaluate((el, value) => { el.scrollTop = 1000 * value; }, height);
    await expectWindowAt(1000);
    await page.getByRole("grid").focus();
    await page.keyboard.press("Control+Home");
    await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  }
});
