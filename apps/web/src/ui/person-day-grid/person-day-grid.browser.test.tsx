// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";
import { activeShows, sideways } from "./person-day-grid.browser-probes";

const [fixture] = Object.values(import.meta.glob<string>("./person-day-grid.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
// The grid as the attendance month view calls it: the real view, drafts, name links and side columns.
const [monthFixture] = Object.values(import.meta.glob<string>("../../features/attendance/ui/month-grid-view.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/person-day-grid-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/person-day-grid/person-day-grid.browser-fixture.tsx", "apps/web/src/features/attendance/ui/month-grid-view.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  // A short box, and for `?row=` its own compact row height, set on a container the way a visual style would set it.
  await page.route("**/grid-test*", route => {
    const query = new URL(route.request().url()).searchParams, row = query.get("row");
    return route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Person-day grid</title>
      <style>main { display: flex; flex-direction: column; height: ${Number(query.get("box") ?? 320)}px; ${row ? `--row-h-compact: ${Number(row)}px;` : ""} }</style>
      <div id="root"></div><script type="module" src="${fixture}"></script></html>` });
  });
  // The month view in a box of `?w=` by `?h=` px: 31 days are wider than most boxes.
  await page.route("**/month-test*", route => {
    const query = new URL(route.request().url()).searchParams;
    return route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Month grid</title>
      <style>main { display: flex; flex-direction: column; width: ${Number(query.get("w") ?? 900)}px; height: ${Number(query.get("h") ?? 320)}px; }</style>
      <div id="root"></div><script type="module" src="${monthFixture}"></script></html>` });
  });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// The base token's 32 px, then a smaller and a larger row, as a visual style or a container would set them.
test.each([null, 24, 40])("virtual rows are placed by the compact row height the CSS gives (%s px)", async row => {
  await page.goto(`${server.resolvedUrls!.local[0]}grid-test${row ? `?row=${row}` : ""}`);
  const height = row ?? 32;
  const grid = page.getByRole("grid", { name: "October" });
  const scroller = grid.locator("..");
  await element(grid.getByText("Person 1", { exact: true })).toBeVisible();
  const measure = () => scroller.evaluate(el => ({
    scroll: el.scrollHeight,
    head: el.querySelector("thead")!.getBoundingClientRect().height,
    row: el.querySelector("tbody tr:not([aria-hidden])")!.getBoundingClientRect().height,
  }));
  // The rows drawn plus the spacers stand for all 400 rows at the height the rows really have.
  await expect.poll(async () => { const m = await measure(); return Math.round(m.scroll - m.head); }).toBe(400 * height);
  expect((await measure()).row).toBe(height);

  // Scrolled to the end, the last person is drawn and the extent has not changed.
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await element(grid.getByText("Person 400", { exact: true })).toBeVisible();
  expect(Math.round((await measure()).scroll - (await measure()).head)).toBe(400 * height);

  // Moving the focus by key keeps the focused cell inside the box, under the sticky head.
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await grid.focus();
  for (let i = 0; i < 60; i++) await grid.press("ArrowDown");
  await expect.poll(async () => {
    const active = await grid.getAttribute("aria-activedescendant");
    return scroller.evaluate((el, id) => {
      const cell = id ? document.getElementById(id) : null;
      if (!cell) return "no active cell";
      // The head cells are the sticky part: the row group they sit in scrolls away with the rows.
      const bounds = cell.getBoundingClientRect(), box = el.getBoundingClientRect(), head = el.querySelector("thead th")!.getBoundingClientRect();
      return bounds.top >= head.bottom - 1 && bounds.bottom <= box.bottom + 1 ? "in view" : `out of view: ${bounds.top}-${bounds.bottom} in ${head.bottom}-${box.bottom}`;
    }, active);
  }).toBe("in view");
  await element(grid.getByText("Person 61", { exact: true })).toBeVisible();
});

test("a box taller than 600 px is filled with rows before the first scroll", async () => {
  await page.setViewportSize({ width: 1000, height: 1400 });
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}grid-test?box=1200`);
    const grid = page.getByRole("grid", { name: "October" });
    await element(grid.getByText("Person 1", { exact: true })).toBeVisible();
    // The last person drawn ends at or below the foot of the box: no blank band under the rows.
    await expect.poll(() => grid.locator("..").evaluate(el => {
      const rows = el.querySelectorAll("tbody tr:not([aria-hidden])");
      return Math.round(rows[rows.length - 1]!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom) >= 0;
    })).toBe(true);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

// The month view: twelve people, October's 31 days, no drafts. Keys after the first focus go to the page, as a person's do.
let drafts: Locator, editor: Locator;
const month = async (query = "") => {
  await page.goto(`${server.resolvedUrls!.local[0]}month-test${query}`);
  const grid = page.getByRole("grid");
  drafts = page.locator("#drafts");
  editor = page.getByRole("textbox");
  await element(grid.getByRole("link", { name: "Person 1", exact: true })).toBeVisible();
  return grid;
};
const dayCell = (person: number, day: number) => page.locator("tbody tr").filter({ has: page.getByRole("link", { name: `Person ${person}`, exact: true }) }).locator("td").nth(day - 1);
/** The active cell as "row,column", counted from 0. */
const active = async () => (await page.getByRole("grid").getAttribute("aria-activedescendant"))?.match(/r(\d+)-c(\d+)$/)?.slice(1).join(",");
const FIRST = '"0001|2026-10-01":"9-18"';

test("when an edit ends the grid has the focus again, so the next key lands on it", async () => {
  const grid = await month();
  await grid.focus();
  await page.keyboard.type("9-18");
  await element(editor).toBeFocused();
  await page.keyboard.press("Enter");
  await element(drafts).toHaveText(`{${FIRST}}`);
  await element(grid).toBeFocused();
  expect(await active()).toBe("1,0");
  // One edit is one step back: taking the focus back did not commit a second time.
  await page.keyboard.press("Control+z");
  await element(drafts).toHaveText("{}");
  await page.keyboard.press("Control+y");
  await element(drafts).toHaveText(`{${FIRST}}`);
  expect(await active()).toBe("1,0");

  await page.keyboard.press("ArrowRight");
  await expect.poll(active).toBe("1,1");
  await page.keyboard.type("x");
  await page.keyboard.press("Tab");
  await element(drafts).toHaveText(`{${FIRST},"0002|2026-10-02":"x"}`);
  await element(grid).toBeFocused();
  expect(await active()).toBe("1,2");

  await page.keyboard.type("o");
  await element(editor).toBeFocused();
  await page.keyboard.press("Escape");
  await element(editor).toHaveCount(0);
  await element(grid).toBeFocused();
  await element(drafts).toHaveText(`{${FIRST},"0002|2026-10-02":"x"}`);
  await page.keyboard.press("ArrowDown");
  await expect.poll(active).toBe("2,2");
});

test("an edit opened with the pointer gives the focus to what is pressed next", async () => {
  const grid = await month();
  // A press on another cell commits and the grid has the focus. (Cells left of the editor's column: they do not move
  // when it closes.)
  await dayCell(1, 5).dblclick();
  await element(editor).toBeFocused();
  await page.keyboard.type("9-18");
  await dayCell(3, 3).click();
  await element(drafts).toHaveText('{"0001|2026-10-05":"9-18"}');
  await element(grid).toBeFocused();
  expect(await active()).toBe("2,2");
  // It has it as from any press: without the focus ring a key brings.
  expect(await grid.evaluate(el => el.matches(":focus-visible"))).toBe(false);
  await page.keyboard.press("ArrowDown");
  await expect.poll(active).toBe("3,2");
  // Opened with a double-click and closed with a key, the grid has it too.
  await dayCell(2, 2).dblclick();
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  await element(grid).toBeFocused();
  expect(await grid.evaluate(el => el.matches(":focus-visible"))).toBe(true);
  expect(await active()).toBe("2,1");
  // A press outside the grid commits and keeps the focus where the person put it.
  await dayCell(4, 4).dblclick();
  await page.keyboard.type("o");
  const outside = page.getByRole("button", { name: "Outside" });
  await outside.click();
  await element(drafts).toHaveText('{"0001|2026-10-05":"9-18","0002|2026-10-02":"x","0004|2026-10-04":"o"}');
  await element(outside).toBeFocused();
});

test("a person's name link opens with Enter, and keys pressed on it are not the grid's", async () => {
  const grid = await month();
  // A draft under the selection, which Backspace on the grid would clear.
  await dayCell(1, 1).dblclick();
  await page.keyboard.type("9-18");
  await dayCell(1, 2).click();
  await dayCell(1, 1).click();
  await element(drafts).toHaveText(`{${FIRST}}`);
  await element(grid).toBeFocused();
  await page.keyboard.press("Tab");
  const link = grid.getByRole("link", { name: "Person 1", exact: true });
  await element(link).toBeFocused();
  await page.keyboard.press("Enter");
  await element(page.locator("#search")).toHaveText("?person=00000000-0000-4000-8000-000000000001");
  await element(editor).toHaveCount(0);
  // The grid's own keys and the month view's (the day sheet, clear, the month, an edit) do nothing from the link.
  await link.focus();
  for (const key of ["p", "Backspace", "Delete", "]", "8", "F2", "ArrowDown"]) await page.keyboard.press(key);
  await element(link).toBeFocused();
  await element(editor).toHaveCount(0);
  await element(drafts).toHaveText(`{${FIRST}}`);
  await element(page.locator("#acts")).toHaveText("");
  expect(await active()).toBe("0,0");
});

test("a press inside the open editor places the caret and keeps the editor", async () => {
  const grid = await month();
  await grid.focus();
  await page.keyboard.type("12345");
  await editor.click();
  await element(editor).toBeFocused();
  await element(editor).toHaveValue("12345");
  await element(drafts).toHaveText("{}");
  // A double-click selects the word it is on; what is typed next replaces it.
  await editor.dblclick();
  await element(editor).toHaveValue("12345");
  await page.keyboard.type("9-18");
  await element(editor).toHaveValue("9-18");
  await page.keyboard.press("Enter");
  await element(drafts).toHaveText(`{${FIRST}}`);
});

test("Enter, F2 and a double-click open the editor on the cell's draft, and leaving it unchanged keeps the draft", async () => {
  await month();
  const DRAFT = '{"0001|2026-10-05":"9-18"}';
  await dayCell(1, 5).dblclick();
  await page.keyboard.type("9-18");
  await dayCell(2, 2).click();
  await element(drafts).toHaveText(DRAFT);

  // A double-click, then a press on another cell.
  await dayCell(1, 5).dblclick();
  await element(editor).toBeFocused();
  await dayCell(2, 2).click();
  await element(editor).toHaveCount(0);
  await element(drafts).toHaveText(DRAFT);
  await dayCell(1, 5).dblclick();
  await element(editor).toHaveValue("9-18");
  await page.keyboard.press("Escape");
  // Enter then Enter, F2 then Tab.
  for (const [open, close] of [["Enter", "Enter"], ["F2", "Tab"]] as const) {
    await dayCell(1, 5).click();
    await page.keyboard.press(open);
    await element(editor).toHaveValue("9-18");
    await page.keyboard.press(close);
    await element(editor).toHaveCount(0);
    await element(drafts).toHaveText(DRAFT);
  }
  // None of those was a change, so one step back undoes the draft itself.
  await dayCell(2, 2).click();
  await page.keyboard.press("Control+z");
  await element(drafts).toHaveText("{}");
  await page.keyboard.press("Control+y");
  await element(drafts).toHaveText(DRAFT);

  // A typed character still starts over, and emptying the editor still removes the draft.
  await dayCell(1, 5).click();
  await page.keyboard.type("x");
  await element(editor).toHaveValue("x");
  await page.keyboard.press("Escape");
  await element(drafts).toHaveText(DRAFT);
  await dayCell(1, 5).dblclick();
  await editor.fill("");
  await page.keyboard.press("Enter");
  await element(drafts).toHaveText("{}");
  // A cell with no draft opens empty, and leaving it is not a step to undo.
  await dayCell(3, 3).dblclick();
  await element(editor).toHaveValue("");
  await page.keyboard.press("Enter");
  await dayCell(2, 2).click();
  await page.keyboard.press("Control+z");
  await element(drafts).toHaveText(DRAFT);
});

// The month view passes four total columns and, when someone has no schedule, a third lead column.
test.each([["", 2], ["&unscheduled", 3]] as const)("sticky side columns stand side by side at every sideways scroll position (%s)", async (extra, lead) => {
  const grid = await month(`?w=1000${extra}`);
  const { end } = await sideways(grid, 0, lead);
  expect(end).toBeGreaterThan(600);
  for (const to of [0, 300, end]) {
    // All four totals stay at the right edge, with a week of days and more between the two sides.
    const at = await sideways(grid, to, lead);
    expect({ ...at, days: at.days >= 7 }, `scrolled to ${to}`).toEqual({ faults: [], days: true, totals: 4, end, totalsEnd: 0 });
  }
});

test("a box with less room holds the outer totals only, and a week of days stays in view", async () => {
  // About the grid column beside a docked sheet on a laptop.
  const grid = await month("?w=640");
  const { end } = await sideways(grid, 0, 2);
  for (const to of [0, 300]) {
    const at = await sideways(grid, to, 2);
    expect({ ...at, days: at.days >= 7 }, `scrolled to ${to}`).toEqual({ faults: [], days: true, totals: 2, end, totalsEnd: 0 });
  }
  // The other two are where the row ends, beside the two that were held.
  expect(await sideways(grid, end, 2)).toMatchObject({ faults: [], totals: 4, totalsEnd: 0 });
});

test("a box too narrow for any holds no totals: they scroll with the days and end the row", async () => {
  const grid = await month("?w=452&unscheduled");
  const { end } = await sideways(grid, 0, 3);
  for (const to of [0, 300]) {
    const at = await sideways(grid, to, 3);
    expect({ ...at, days: at.days >= 3 }, `scrolled to ${to}`).toEqual({ faults: [], days: true, totals: 0, end, totalsEnd: at.totalsEnd });
  }
  // At the end of the row the totals show whole (over the lead columns, which a box this narrow cannot also show).
  const last = await sideways(grid, end, 3);
  expect(last.faults.filter(fault => fault.includes("total"))).toEqual([]);
  expect(last).toMatchObject({ totals: 4, totalsEnd: 0 });
});

test("a grid that fits its box has every column where the table puts it", async () => {
  await page.setViewportSize({ width: 2300, height: 720 });
  try {
    const grid = await month("?w=2200&unscheduled");
    expect(await sideways(grid, 0, 3)).toEqual({ faults: [], days: 31, totals: 4, end: 0, totalsEnd: 0 });
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

// The box's width, and the day column that starts in view and ends under the totals before any scroll.
test.each([[1000, 12], [640, 7]])("moving the active cell sideways keeps it in view between the sticky columns (a %s px box)", async (width, cut) => {
  const grid = await month(`?w=${width}`);
  await grid.focus();
  expect(await activeShows(grid)).toBe("in view");
  for (let i = 0; i < 14; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(active).toBe("0,14");
  await expect.poll(() => activeShows(grid)).toBe("in view");
  // The editor is wider than a day, and shows whole too.
  await page.keyboard.type("9");
  await element(editor).toBeFocused();
  await expect.poll(() => activeShows(grid)).toBe("in view");
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  await expect.poll(active).toBe("0,30");
  await expect.poll(() => activeShows(grid)).toBe("in view");
  // Back the other way the lead columns cover the left of the box.
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowLeft");
  await expect.poll(active).toBe("0,10");
  await expect.poll(() => activeShows(grid)).toBe("in view");
  await page.keyboard.press("Home");
  await expect.poll(active).toBe("0,0");
  await expect.poll(() => grid.locator("..").evaluate(el => el.scrollLeft)).toBe(0);
  // A press on the part of a cell that shows brings the rest of it into view, and selects that cell alone.
  await dayCell(2, cut + 1).click({ position: { x: 6, y: 10 } });
  await expect.poll(active).toBe(`1,${cut}`);
  await expect.poll(() => activeShows(grid)).toBe("in view");
  await element(grid.locator('td[aria-selected="true"]')).toHaveCount(1);
});
