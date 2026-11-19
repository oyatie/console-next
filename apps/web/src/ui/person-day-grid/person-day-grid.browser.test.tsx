// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./person-day-grid.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/person-day-grid-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/person-day-grid/person-day-grid.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  // A short box, and for `?row=` its own compact row height, set on a container the way a visual style would set it;
  // `?style=` names the visual style the page is drawn in.
  await page.route("**/grid-test*", route => {
    const query = new URL(route.request().url()).searchParams, row = query.get("row"), style = query.get("style");
    return route.fulfill({ contentType: "text/html", body: `<html lang="ko"${style ? ` data-experience="${style}"` : ""}><title>Person-day grid</title>
      <style>main { display: flex; flex-direction: column; height: ${Number(query.get("box") ?? 320)}px; ${row ? `--row-h-compact: ${Number(row)}px;` : ""} }</style>
      <div id="root"></div><script type="module" src="${fixture}"></script></html>` });
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

// Rows 24 px apart leave two neighbouring names exactly the spacing a pointer needs. So in a visual style a row's rules
// take no room in it, and a name is a target as tall as its row.
test("in a visual style, names stay evenly spaced and each is a whole pointer target, also half under the head", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}grid-test?groups&row=24&style=control-room`);
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
