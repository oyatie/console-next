// SPDX-License-Identifier: LicenseRef-Proprietary
import { chromium, firefox, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { gridRow, queue } from "../e2e/helpers/import-queue";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await (process.env.E2E_XBROWSER === "1" ? firefox : chromium).launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); });

test("an import row waits for the grids to mount before choosing its value table", async () => {
  const result = gridRow(queue(page), "품질팀").then(async row => ({ text: await row.innerText() }), error => ({ error: String(error) }));
  expect(await queue(page).count()).toBe(0);
  await page.setContent('<table role="grid" aria-label="값 연결 · 부서"><tbody><tr><td>품질팀</td><td>60</td></tr></tbody></table><table role="grid" aria-label="확인 필요"><tbody><tr><td>다른 확인 항목</td></tr></tbody></table>');
  expect(await result).toEqual({ text: "품질팀\t60" });
});
