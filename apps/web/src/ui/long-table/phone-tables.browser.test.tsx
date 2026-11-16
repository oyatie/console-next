// SPDX-License-Identifier: LicenseRef-Proprietary
import { AxeBuilder } from "@axe-core/playwright";
import { expect as visible, type Browser, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { columnWidths, paging, phoneTableTest } from "../../../../../e2e/phone-table-fixture";

let server: ViteDevServer;
let browser: Browser, page: Page;
beforeAll(async () => { ({ server, browser, page } = await phoneTableTest()); }, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("390px cards expose identifiers, status, labelled facts and actions without overflow; axe passes", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables`);
  const short = page.getByRole("grid", { name: "Short", exact: true });
  const long = page.getByRole("grid", { name: "Long", exact: true });
  await visible(short.getByRole("row").filter({ hasText: "MOB-0" })).toHaveCSS("display", "grid");
  await visible(long).toHaveAttribute("data-layout", "cards");
  const longSelectAll = long.getByRole("checkbox", { name: "Select all 100", exact: true });
  const selectControl = longSelectAll.locator("xpath=ancestor::label[1]");
  await visible(selectControl).toBeVisible();
  const [selectHeader, selectBox, cardCaption, longBox, firstLongRow] = await Promise.all([
    long.getByRole("columnheader").first().boundingBox(),
    selectControl.boundingBox(),
    long.getByRole("columnheader", { name: "Long", exact: true }).boundingBox(),
    long.boundingBox(),
    long.getByRole("row").filter({ hasText: "MOB-0" }).boundingBox(),
  ]);
  expect(selectHeader!.width).toBeGreaterThan(200);
  expect(selectHeader!.height).toBeGreaterThanOrEqual(36);
  expect(selectBox!.height).toBeGreaterThanOrEqual(16);
  expect(selectBox!.width).toBeGreaterThan(selectBox!.height * 2);
  expect(Math.max(cardCaption!.width, cardCaption!.height)).toBeLessThanOrEqual(1);
  expect(firstLongRow!.y - longBox!.y).toBeGreaterThanOrEqual(36);
  for (const table of [short, long]) {
    const row = table.getByRole("row").filter({ hasText: "MOB-0" });
    await visible(row.getByText("MOB-0", { exact: true })).toBeVisible();
    await visible(row.getByText("Active", { exact: true })).toBeVisible();
    if (table === short) {
      await visible(row.locator('[data-label="Unit"]')).toBeVisible();
      expect(await row.locator('[data-label="Unit"]').evaluate(el => getComputedStyle(el, "::before").content)).toBe('"Unit"');
      await visible(row.locator('[data-card="omit"]')).toHaveCount(0);
      await visible(row).toHaveCSS("grid-template-columns", /^(\d+(?:\.\d+)?px) \1$/);
    } else {
      await visible(row.getByText("Unit", { exact: true })).toBeVisible();
      await visible(row.locator("dt")).toHaveCount(4);
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
}, 30_000);

test.each([390, 260])("%spx caption and search occupy full separate rows above cards without a header gap", async width => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables#stack`);
  const grid = page.getByRole("grid", { name: "Stacked", exact: true });
  const captionLocator = page.getByText("2", { exact: true });
  const findField = page.getByRole("searchbox", { name: "Find", exact: true }).locator("xpath=..");
  const bar = captionLocator.locator("xpath=..");
  const [caption, find, contentWidth, headerBox, gridBox, firstRow] = await Promise.all([
    captionLocator.boundingBox(), findField.boundingBox(),
    bar.evaluate(el => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight)),
    grid.locator('[role="rowgroup"]').first().boundingBox(), grid.boundingBox(),
    grid.getByRole("rowheader", { name: "MOB-0", exact: true }).locator("xpath=ancestor::*[@role='row'][1]").boundingBox(),
  ]);
  expect(caption!.y + caption!.height).toBeLessThanOrEqual(find!.y);
  expect(caption!.width).toBeCloseTo(contentWidth, 0);
  expect(find!.width).toBeCloseTo(contentWidth, 0);
  expect(headerBox!.height).toBe(0);
  const hiddenColumn = await grid.getByRole("columnheader").boundingBox();
  expect(Math.max(hiddenColumn!.width, hiddenColumn!.height)).toBeLessThanOrEqual(1);
  expect(firstRow!.y - gridBox!.y).toBeLessThanOrEqual(1);
}, 30_000);

test.each(["cards", "compact", "rows"])("paged 2,000-row %s at 390px never leave the viewport blank after loading", async (mode) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables#paged-${mode}`);
  const grid = page.getByRole("grid", { name: "Paged", exact: true });
  await visible(grid).toHaveAttribute("data-layout", "cards");
  await visible(grid.getByRole("rowheader", { name: "PAGE-0", exact: true })).toBeVisible();
  const blanks: { loaded: number; jump: number }[] = [];
  for (let jump = 0; jump < paging.reduce((sum, step) => sum + step.jumps, 0); jump++) {
    // Observe the commit and two quiet paint frames; never retry the visibility assertion or scroll to repair it.
    const inView = await grid.evaluate(async (el) => {
      const main = el.closest("main")!;
      await new Promise<void>((done) => {
        let frame: number;
        const paint = () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
              if (main.getAttribute("data-loading") !== "false") return;
              observer.disconnect();
              el.removeEventListener("scroll", paint);
              done();
            });
          });
        };
        const observer = new MutationObserver(paint);
        observer.observe(main, { attributes: true, childList: true, subtree: true });
        el.addEventListener("scroll", paint);
        el.scrollTop = el.scrollHeight;
        paint();
      });
      const box = el.getBoundingClientRect();
      const count = [...el.querySelectorAll('[role="rowheader"]')].filter(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      }).length;
      return { loaded: Number(main.getAttribute("data-loaded")), count };
    });
    if (inView.count === 0) blanks.push({ loaded: inView.loaded, jump });
  }
  expect(blanks).toEqual([]);
  await visible(page.locator("main")).toHaveAttribute("data-loaded", "2000");
  const row = grid.getByRole("rowheader").first();
  const height = await row.evaluate(el => el.getBoundingClientRect().height);
  await page.setViewportSize({ width: 260, height: 844 });
  await visible(async () => {
    const resized = await row.evaluate(el => el.getBoundingClientRect().height);
    expect(resized).toBeGreaterThan(height);
    // Most cards are still unmeasured: their estimate must follow the new wrapping height.
    expect(await grid.evaluate(el => el.scrollHeight)).toBeGreaterThan(resized * 2000 * 0.85);
  }).toPass();
}, 30_000);
test.each([564, 724])("%spx containers keep row identity and actions together in light and dark", async width => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const grid = page.getByRole("grid", { name: "Long", exact: true });
  const row = grid.getByRole("row").filter({ hasText: "MOB-0" });
  for (const theme of ["light", "dark"]) {
    await page.goto(`${server.resolvedUrls!.local[0]}phone-tables`);
    await page.locator("#container").evaluate((el, value) => el.style.width = `${value}px`, width);
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    await visible(grid).toHaveAttribute("data-layout", "cards");
    await grid.scrollIntoViewIfNeeded();
    await visible(row.getByText("MOB-0", { exact: true })).toBeInViewport({ ratio: 1 });
    const action = row.getByRole("button", { name: "Open MOB-0", exact: true });
    await visible(action).toBeInViewport({ ratio: 1 });
    await action.click();
    await visible(page.locator("#action")).toHaveText("MOB-0");
    expect(await grid.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(width);
    // Enter from outside after scrolling: focus must not restore an old position between press and release.
    await page.getByRole("heading", { name: "Phone tables", exact: true }).click();
    const next = grid.getByRole("button", { name: "Open MOB-2", exact: true });
    await next.evaluate(el => el.focus());
    await visible(next).toBeInViewport({ ratio: 1 });
    await next.click();
    await visible(page.locator("#action")).toHaveText("MOB-2");
  }
}, 30_000);

test("container boundary, virtualization and keyboard state survive card/row changes; desktop widths return", async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${server.resolvedUrls!.local[0]}phone-tables`);
  const long = page.getByRole("grid", { name: "Long", exact: true });
  await visible(long.getByRole("rowheader", { name: "MOB-0", exact: true })).toBeVisible();
  const widths = await long.getByRole("columnheader").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
  // Near miss: the viewport stays wide; only the table's container crosses the boundary.
  const minimum = columnWidths.name + columnWidths.status + columnWidths.fact * 4 + columnWidths.action;
  await page.locator("#container").evaluate((el, width) => el.style.width = `${width}px`, widths.reduce((sum, width) => sum + width, 0));
  await visible(long).toHaveAttribute("aria-colcount", String(widths.length));
  await page.locator("#container").evaluate((el, width) => el.style.width = `${width - 1}px`, minimum);
  await visible(long.getByRole("columnheader")).toHaveCount(2);
  await visible(long).toHaveAttribute("data-layout", "cards");
  const row = long.getByRole("row").filter({ hasText: "MOB-0" });
  await row.focus();
  await row.press("Space");
  await visible(row).toHaveAttribute("aria-selected", "true");
  await visible(row).toBeFocused();
  await visible(row).toHaveAttribute("data-row-id", "MOB-0");
  await row.press("Enter");
  await visible(page.locator("#open")).toHaveText("MOB-0");
  expect(await long.getByRole("row").count()).toBeLessThan(30);
  await page.locator("#container").evaluate(el => el.style.removeProperty("width"));
  await visible(long).toHaveAttribute("data-layout", "rows");
  await visible(row).toHaveAttribute("aria-selected", "true");
  await visible(row).toBeFocused();
  expect(await long.getByRole("columnheader").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width))).toEqual(widths);
}, 30_000);

test("the product roster renders both identifiers, status and every fact at 390px", async () => {
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
  await visible(row.locator("dt")).toHaveCount(6);
  await visible(row.locator(".chip")).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
}, 30_000);
test("tables without card metadata use complete cards at 390px and rows on desktop", async () => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("about:blank");
    await page.goto(`${server.resolvedUrls!.local[0]}phone-tables#uncontained`);
    const short = page.getByRole("table", { name: "Uncontained short", exact: true });
    const long = page.getByRole("grid", { name: "Uncontained long", exact: true });
    const containers = [page.locator("#short-flex > *"), page.locator("#long-flex > *")];
    for (const container of containers) {
      expect(await container.evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(width);
      await visible(container).toHaveCSS("container-type", "inline-size");
    }
    const shortRow = short.locator("tbody > tr").first();
    const longRow = long.getByRole("row").filter({ hasText: "MOB-0" });
    const cell = longRow.getByRole("rowheader", { name: "MOB-0", exact: true });
    if (width === 390) {
      await visible(shortRow).toHaveCSS("display", "grid");
      expect(await shortRow.locator("td").evaluateAll(cells => cells.every(item => getComputedStyle(item).display !== "none"))).toBe(true);
      await visible(long).toHaveAttribute("data-layout", "cards");
      await visible(long).toHaveAttribute("aria-colcount", "1");
      await visible(long.locator("dt")).toHaveCount(18);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
    } else {
      await visible(shortRow).toHaveCSS("display", "table-row");
      await visible(long).toHaveAttribute("data-layout", "rows");
      await visible(long).toHaveAttribute("aria-colcount", "7");
      await visible(cell).toHaveCSS("height", "40px");
      await long.locator("xpath=ancestor::section").evaluate(el => el.setAttribute("data-density", "compact"));
      await visible(cell).toHaveCSS("height", "32px");
    }
  }
}, 30_000);
