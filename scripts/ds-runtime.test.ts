// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  const css = ["packages/tokens/tokens.css", "apps/web/src/app.css", "apps/web/src/ui/meter/meter.module.css", "apps/web/src/ui/org-canvas/node-actions.module.css", "apps/web/src/ui/record/record.module.css"]
    .map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/^@import[^;]+;/gm, "")).join("\n");
  await page.setContent(`<style>${css}</style><span class="meter"><span class="fill"></span></span><section style="--unzoom: 2; --record-sticky: 100px; --trigger-width: 120px"><div class="tools"></div><div class="section"></div><div class="popover"></div></section>`);
}, 60_000);
afterAll(async () => { await browser?.close(); });

test("body typography keeps tabular figures after the font shorthand", async () => {
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toBe("tabular-nums");
});

test("module runtime contracts preserve meter percentages and inherited zoom/sticky offsets", async () => {
  for (const pct of [0, 60]) {
    const fraction = await page.locator(".fill").evaluate((el, value) => {
      (el as HTMLElement).style.setProperty("--pct", `${value}%`);
      return el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width;
    }, pct);
    expect(fraction).toBeCloseTo(pct / 100, 2);
  }
  expect(await page.locator(".popover").evaluate((el) => getComputedStyle(el).width)).toBe("120px");
  expect(await page.locator(".tools").evaluate((el) => getComputedStyle(el).scale)).toBe("2");
  expect(await page.locator(".section").evaluate((el) => getComputedStyle(el).scrollMarginTop)).toBe("100px");
});
