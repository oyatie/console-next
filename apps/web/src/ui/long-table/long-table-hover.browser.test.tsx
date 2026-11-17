// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect as dom, type Browser, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { phoneTableTest } from "../../../../../e2e/phone-table-fixture";

let server: ViteDevServer;
let browser: Browser;
const modes = ["dwell", "leave", "scroll", "unmount"] as const;
const pages = {} as Record<typeof modes[number], Page>;
beforeAll(async () => {
  const fixture = await phoneTableTest();
  ({ server, browser } = fixture);
  await fixture.page.goto(`${server.resolvedUrls!.local[0]}phone-tables`);
  await fixture.page.getByRole("grid", { name: "Long", exact: true }).waitFor();
  await fixture.page.close();
  for (const mode of modes) {
    const page = await browser.newPage();
    pages[mode] = page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}phone-tables`);
    await page.getByRole("grid", { name: "Long", exact: true }).waitFor();
  }
}, 60_000);
afterAll(async () => { await Promise.all(Object.values(pages).map(page => page.close())); await browser?.close(); await server?.close(); });

test.each(modes)("row hover waits for a settled pointer and cancels on %s", async mode => {
  const page = pages[mode];
  const grid = page.getByRole("grid", { name: "Long", exact: true });
  const row = grid.locator('[data-row-id="MOB-0"]');
  await grid.scrollIntoViewIfNeeded();
  await dom(row).toBeInViewport({ ratio: 1 });
  await page.mouse.move(0, 0);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await row.dispatchEvent("pointerover", { pointerType: "mouse" });
  await dom(row).toHaveAttribute("data-hovered");
  await page.clock.runFor(149);
  expect(await page.locator("body").getAttribute("data-hover")).toBeNull();
  if (mode === "leave") await row.evaluate(el => el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body })));
  if (mode === "scroll") await grid.evaluate(el => el.dispatchEvent(new Event("scroll")));
  if (mode === "unmount") {
    await page.locator("#hide-table").evaluate((el: HTMLButtonElement) => el.click());
    await dom(grid).toHaveCount(0);
  }
  await page.clock.runFor(150);
  expect(await page.locator("body").getAttribute("data-hover")).toBe(mode === "dwell" ? '["MOB-0"]' : null);
});
