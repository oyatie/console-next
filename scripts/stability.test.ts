// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { recordShifts, SHIFT_BUDGET } from "../e2e/stability";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(recordShifts);
  await page.route("https://stability.test/**", route => route.fulfill({
    contentType: "text/html",
    body: '<button id="command">Save</button><div id="content" style="height:500px;background:gray">Record</div>',
  }));
}, 60_000);
afterAll(async () => { await browser?.close(); });

test.each(["auth/token/refresh", "auth/privacy-consent/status", "background/status"])("counts cold-load shifts immediately after POST %s", async path => {
  await page.goto("https://stability.test/");
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(async path => {
    await fetch(`/api/v1/${path}`, { method: "POST" });
    document.getElementById("content")!.style.marginTop = "200px";
  }, path);
  await expect.poll(() => page.evaluate(() => window.__shifts?.reduce((total, shift) => total + shift.value, 0) ?? 0)).toBeGreaterThan(SHIFT_BUDGET);
});

test("a user command still exempts its own result", async () => {
  await page.goto("https://stability.test/");
  await page.evaluate(() => {
    document.getElementById("command")!.onclick = async () => {
      await fetch("/api/v1/record", { method: "POST" });
      document.getElementById("content")!.style.marginTop = "200px";
    };
  });
  await page.click("#command");
  await page.waitForFunction(() => document.getElementById("content")!.style.marginTop === "200px");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__shifts)).toEqual([]);
});
