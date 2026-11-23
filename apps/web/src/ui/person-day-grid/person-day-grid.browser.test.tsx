// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element, type Locator } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";
import { editingCases } from "./person-day-grid.browser-editing";
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
  // A short box, for `?w=` a narrow one, and for `?row=` its own compact row height, set on a container the way a
  // visual style would set it; `?style=` names the visual style the page is drawn in.
  await page.route("**/grid-test*", route => {
    const query = new URL(route.request().url()).searchParams, row = query.get("row"), width = query.get("w"), style = query.get("style");
    return route.fulfill({ contentType: "text/html", body: `<html lang="ko"${style ? ` data-experience="${style}"` : ""}><title>Person-day grid</title>
      <style>main { display: flex; flex-direction: column; height: ${Number(query.get("box") ?? 320)}px; ${width ? `width: ${Number(width)}px;` : ""} ${row ? `--row-h-compact: ${Number(row)}px;` : ""} }</style>
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

// One total cannot lie on another, so it is held in a box of any width: a phone's, and one with no room for a day beside it.
test.each([390, 180])("a grid with one total column keeps it at the right edge of a %s px box", async width => {
  await page.goto(`${server.resolvedUrls!.local[0]}grid-test?total&w=${width}`);
  const grid = page.getByRole("grid", { name: "October" });
  await element(grid.getByText("Person 1", { exact: true })).toBeVisible();
  // How far the total's head and first cell end from the box's right edge, at a sideways scroll position.
  const total = (to: number) => grid.locator("..").evaluate((el, left) => {
    el.scrollLeft = left;
    const right = el.getBoundingClientRect().left + el.clientWidth;
    const ends = [el.querySelector("thead tr")!, el.querySelector("tbody tr:not([aria-hidden])")!].map(row => Math.round(right - row.lastElementChild!.getBoundingClientRect().right));
    return { ends, end: el.scrollWidth - el.clientWidth };
  }, to);
  const { end } = await total(0);
  // Ten days do not fit: the box scrolls sideways.
  expect(end).toBeGreaterThan(100);
  for (const to of [0, 100, end]) await expect.poll(async () => (await total(to)).ends, { message: `scrolled to ${to}` }).toEqual([0, 0]);
});

// The month view: twelve people, October's 31 days, no drafts. Keys after the first focus go to the page, as a person's do.
let editor: Locator;
const month = async (query = "") => {
  await page.goto(`${server.resolvedUrls!.local[0]}month-test${query}`);
  const grid = page.getByRole("grid");
  editor = page.getByRole("textbox");
  await element(grid.getByRole("link", { name: "Person 1", exact: true })).toBeVisible();
  // The web font can still be arriving: a column it widens moves the side columns a frame later, so measures wait for it.
  await page.evaluate(() => document.fonts.ready);
  return grid;
};
const dayCell = (person: number, day: number) => page.locator("tbody tr").filter({ has: page.getByRole("link", { name: `Person ${person}`, exact: true }) }).locator("td").nth(day - 1);
/** The active cell as "row,column", counted from 0. */
const active = async () => (await page.getByRole("grid").getAttribute("aria-activedescendant"))?.match(/r(\d+)-c(\d+)$/)?.slice(1).join(",");

// Its editing cases (typing, the editor's keys, presses, the name links) are in their own file and run here.
editingCases(() => ({ page, month, dayCell, active }));

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
  // An open editor makes its day wider than the rest; the totals are held as before.
  await grid.focus();
  await page.keyboard.type("9");
  await element(editor).toBeFocused();
  expect(await sideways(grid, 0, lead)).toMatchObject({ faults: [], totals: 4, totalsEnd: 0 });
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

// The last total stays at the right edge while a day shows beside it: a phone, and three lead columns in a wider box.
test.each([["?w=358", 2], ["?w=452&unscheduled", 3]] as const)("a narrow box holds the last total only, with days in view beside it (%s)", async (query, lead) => {
  const grid = await month(query);
  const { end } = await sideways(grid, 0, lead);
  for (const to of [0, 300]) {
    const at = await sideways(grid, to, lead);
    expect({ ...at, days: at.days >= 1 }, `scrolled to ${to}`).toEqual({ faults: [], days: true, totals: 1, end, totalsEnd: 0 });
  }
  // At the end of the row all four show whole (over the lead columns, which a box this narrow cannot also show).
  const last = await sideways(grid, end, lead);
  expect(last.faults.filter(fault => fault.includes("total"))).toEqual([]);
  expect(last).toMatchObject({ totals: 4, totalsEnd: 0 });
});

test("a box with no room for a day beside a total holds none: they scroll with the days and end the row", async () => {
  // Three lead columns on a phone.
  const grid = await month("?w=358&unscheduled");
  const { end } = await sideways(grid, 0, 3);
  for (const to of [0, 300]) {
    const at = await sideways(grid, to, 3);
    expect({ ...at, days: at.days >= 1 }, `scrolled to ${to}`).toEqual({ faults: [], days: true, totals: 0, end, totalsEnd: at.totalsEnd });
  }
  const last = await sideways(grid, end, 3);
  expect(last.faults.filter(fault => fault.includes("total"))).toEqual([]);
  expect(last).toMatchObject({ totals: 4, totalsEnd: 0 });
});

test("a grid that fits its box has every column where the table puts it", async () => {
  await page.setViewportSize({ width: 2300, height: 720 });
  try {
    const grid = await month("?w=2200&unscheduled");
    await expect.poll(() => sideways(grid, 0, 3)).toEqual({ faults: [], days: 31, totals: 4, end: 0, totalsEnd: 0 });
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test("a grid that fits its box places its side columns again when what a column holds changes width with no render", async () => {
  await page.setViewportSize({ width: 2300, height: 720 });
  try {
    const grid = await month("?w=2200&unscheduled");
    const fits = { faults: [], days: 31, totals: 4, end: 0, totalsEnd: 0 };
    await expect.poll(() => sideways(grid, 0, 3)).toEqual(fits);
    const widths = () => page.locator("thead th").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
    const before = await widths();
    // As a font arriving does: the table keeps the box's width, and shares it out again between the columns.
    await page.addStyleTag({ content: "thead th:nth-last-child(-n+4) { letter-spacing: 2px; }" });
    await expect.poll(async () => (await widths()).slice(-4).some((width, k) => width !== before.at(k - 4))).toBe(true);
    await expect.poll(() => sideways(grid, 0, 3)).toEqual(fits);
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
  // A press on a person's number selects the row, to its last day, and the box stays where it is.
  await grid.getByText("1002", { exact: true }).click();
  await element(grid.locator('td[aria-selected="true"]')).toHaveCount(31);
  expect(await active()).toBe("1,30");
  expect(await grid.locator("..").evaluate(el => el.scrollLeft)).toBe(0);
  // A press on the part of a cell that shows brings the rest of it into view, and selects that cell alone.
  await dayCell(2, cut + 1).click({ position: { x: 6, y: 10 } });
  await expect.poll(active).toBe(`1,${cut}`);
  await expect.poll(() => activeShows(grid)).toBe("in view");
  await element(grid.locator('td[aria-selected="true"]')).toHaveCount(1);
});

test("a key that keeps the active cell's column brings it back into view after the box was moved without it", async () => {
  const grid = await month("?w=1000");
  const box = grid.locator(".."), scrollTo = (left: number) => box.evaluate((el, to) => { el.scrollLeft = to; }, left);
  await grid.focus();
  // On day 1 with the box scrolled away by hand: a move down, then two keys with nowhere further to go.
  for (const [key, cell] of [["ArrowDown", "1,0"], ["ArrowLeft", "1,0"], ["Home", "1,0"]] as const) {
    await scrollTo(500);
    await page.keyboard.press(key);
    await expect.poll(active).toBe(cell);
    await expect.poll(() => activeShows(grid), { message: key }).toBe("in view");
  }
  // On day 31 with the box scrolled back to the start.
  await page.keyboard.press("End");
  for (const [key, cell] of [["ArrowDown", "2,30"], ["Shift+ArrowDown", "3,30"]] as const) {
    await scrollTo(0);
    await page.keyboard.press(key);
    await expect.poll(active).toBe(cell);
    await expect.poll(() => activeShows(grid), { message: key }).toBe("in view");
  }
  // A press on a person's number leaves the box where it is; the next key is followed.
  await scrollTo(0);
  await grid.getByText("1002", { exact: true }).click();
  expect(await active()).toBe("1,30");
  expect(await box.evaluate(el => el.scrollLeft)).toBe(0);
  await page.keyboard.press("ArrowDown");
  await expect.poll(active).toBe("2,30");
  await expect.poll(() => activeShows(grid)).toBe("in view");
  // So is the key after a press on a number that the browser cancelled (a touch that became a pan).
  await scrollTo(0);
  const number = grid.getByText("1004", { exact: true });
  await number.dispatchEvent("pointerdown");
  await number.dispatchEvent("pointercancel");
  await expect.poll(active).toBe("3,30");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(active).toBe("3,29");
  await expect.poll(() => activeShows(grid)).toBe("in view");
});

// Rows 24 px apart leave two neighbouring names exactly the spacing a pointer needs. So in a visual style a row's rules
// take no room in it, and a name is a target as tall as its row.
test("in a visual style, names stay evenly spaced and each is a whole pointer target, also half under the head", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}grid-test?groups&row=24&style=console`);
  const grid = page.getByRole("grid", { name: "October" });
  await element(grid.getByRole("link", { name: "Person 1", exact: true })).toBeVisible();
  const drawn = await grid.evaluate(el => {
    const rows = [...el.querySelectorAll("tbody tr:not([aria-hidden])")].slice(0, 9);
    const links = rows.map(row => row.querySelector("a")!.getBoundingClientRect());
    const centres = links.map(b => b.top + b.height / 2);
    const rules = (row: number) => getComputedStyle(rows[row]!.firstElementChild!).boxShadow.split("inset").length - 1;
    return {
      rows: rows.map(row => row.getBoundingClientRect().height),
      gaps: centres.slice(1).map((centre, i) => centre - centres[i]!),
      smallest: Math.min(...links.flatMap(b => [b.width, b.height])),
      rules: [rules(3), rules(4)],
    };
  });
  const nine = <T,>(value: T) => Array.from({ length: 9 }, () => value);
  expect(drawn.rows).toEqual(nine(24));
  expect(drawn.gaps).toEqual(nine(24).slice(1));
  expect(drawn.smallest).toBeGreaterThanOrEqual(24);
  // The fourth person starts a group and has its rule above the line every row has below; the fifth has the line only.
  expect(drawn.rules).toEqual([2, 1]);

  // Scrolled so that one name is half under the sticky head, the names still meet the target-size rule.
  await grid.locator("..").evaluate(el => { el.scrollTop = 24 * 5 + 12; });
  const { violations } = await new AxeBuilder({ page }).withRules(["target-size"]).setLegacyMode(true).analyze();
  expect(violations.flatMap(v => v.nodes.map(n => n.target.join(" ")))).toEqual([]);
});
