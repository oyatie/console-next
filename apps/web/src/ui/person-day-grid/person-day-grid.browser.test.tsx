// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";
import { editingCases, paste } from "./person-day-grid.browser-editing";
import { sidewaysCases } from "./person-day-grid.browser-sideways";

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
  // A short box, `?w=` wide, with `?row=` its own compact row height as a visual style would set it, in the style `?style=` names.
  await page.route("**/grid-test*", route => {
    const query = new URL(route.request().url()).searchParams, row = query.get("row"), width = query.get("w"), style = query.get("style");
    return route.fulfill({ contentType: "text/html", body: `<html lang="ko"${style ? ` data-experience="${style}"` : ""}><title>Person-day grid</title>
      <style>main { display: flex; flex-direction: column; height: ${Number(query.get("box") ?? 320)}px; ${width ? `width: ${Number(width)}px;` : ""} ${row ? `--row-h-compact: ${Number(row)}px;` : ""} }</style>
      <div id="root"></div><script type="module" src="${fixture}"></script></html>` });
  });
  // The month view in a box `?w=` px wide (31 days are wider than most boxes) and 320 px high, in the visual style `?style=` names.
  await page.route("**/month-test*", route => {
    const query = new URL(route.request().url()).searchParams, style = query.get("style");
    return route.fulfill({ contentType: "text/html", body: `<html lang="ko"${style ? ` data-experience="${style}"` : ""}><title>Month grid</title>
      <style>main { display: flex; flex-direction: column; width: ${Number(query.get("w") ?? 900)}px; height: 320px; }</style>
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

// Fewer rows than the box was scrolled past: until the box reports its new scroll, no person row is drawn.
test("rows that shrink under a range of many people, with the box scrolled past them, leave the grid drawn", async () => {
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}grid-test?shrink`);
    const grid = page.getByRole("grid", { name: "October" });
    await element(grid.getByText("Person 1", { exact: true })).toBeVisible();
    // A press on the day header selects every person with the focus on the last, and the box scrolls down to them.
    await grid.locator("thead th").nth(1).click();
    await element(grid.getByText("Person 400", { exact: true })).toBeVisible();
    // Thirty people are left, the last among them, so the range collapses to that person.
    await page.getByRole("button", { name: "Shrink" }).click();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done))));
    expect(errors).toEqual([]);
    // Drawn again once the box reports where it is, the one cell selected being that person's.
    await element(grid.locator('td[aria-selected="true"]')).toHaveAttribute("aria-label", "Person 400 day 1");
  } finally {
    page.off("pageerror", onError);
  }
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

// The month view: twelve people, October's 31 days, no drafts. Keys after the first focus go to the page, as a person's do.
type Look = { style?: string; phone?: boolean };
const month = (look: Look) => async (query = "") => {
  await page.setViewportSize(look.phone ? { width: 390, height: 844 } : { width: 1280, height: 720 });
  const search = new URLSearchParams(query);
  if (look.style) search.set("style", look.style);
  // A phone's box is as wide as its screen.
  if (look.phone) search.set("w", "390");
  await page.goto(`${server.resolvedUrls!.local[0]}month-test?${search}`);
  const grid = page.locator("main").getByRole("grid");
  await element(grid.getByRole("link", { name: "Person 1", exact: true })).toBeVisible();
  // The web font can still be arriving: a column it widens moves the others a frame later, so measures wait for it.
  await page.evaluate(() => document.fonts.ready);
  return grid;
};
const dayCell = (person: number, day: number) => page.locator("main tbody tr").filter({ has: page.getByRole("link", { name: `Person ${person}`, exact: true }) }).locator("td").nth(day - 1);
/** The active cell as "row,column", counted from 0. */
const active = async () => (await page.locator("main").getByRole("grid").getAttribute("aria-activedescendant"))?.match(/r(\d+)-c(\d+)$/)?.slice(1).join(",");

// Every look the month view has, at a desk and on a phone; last in the file, since its cases leave the page at their screen size.
describe.each([["classic", {}], ["console", { style: "console" }], ["console on a phone", { style: "console", phone: true }]] as const)("the month view, %s", (_, look: Look) => {
  const view = () => ({ page, month: month(look), dayCell, active });
  editingCases(view);
  // A desk's box, and about the grid column beside a docked sheet on a laptop.
  sidewaysCases(view, look.phone ? [""] : ["?w=1000", "?w=640"]);

  test.runIf(look.style)("the console's lead columns are drawn as the screen draws them", async () => {
    const grid = await month(look)();
    // Name and number are held; the unit scrolls with the days at a desk and is not drawn on a phone.
    const leads = await grid.locator("tbody tr:not([aria-hidden])").first().locator("th").evaluateAll(cells => cells.map(cell => ({ position: getComputedStyle(cell).position, width: cell.getBoundingClientRect().width })));
    expect(leads.map(lead => lead.position)).toEqual(["sticky", "sticky", "static"]);
    expect(leads[2]!.width === 0).toBe(!!look.phone);
  });

  test.runIf(look.style)("a paste while another grid on the screen, or a row of it, has the focus opens no paste preview", async () => {
    const grid = await month(look)();
    await grid.focus();
    const other = page.getByRole("grid").last();
    await other.getByRole("row").nth(1).focus();
    await paste(page);
    await element(page.getByRole("dialog")).toHaveCount(0);
    await other.evaluate((el) => (el.tabIndex = -1, el.focus()));
    await paste(page);
    await element(page.getByRole("dialog")).toHaveCount(0);
    await grid.focus();
    await paste(page);
    await element(page.getByRole("dialog")).toHaveCount(1);
  });
});
