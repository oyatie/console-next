// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const html = readFileSync(new URL("./src-tauri/src/external.html", import.meta.url), "utf8");

test("desktop interstitial requires an explicit trusted decision", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const destination = "https://external.test/path?q=%22%3Cscript%3E#section";
  const initial = `data:text/html,${encodeURIComponent(html)}#${encodeURIComponent(destination)}`;

  await page.goto(initial);
  assert.equal(await page.locator("#destination").textContent(), destination);
  assert.equal(await page.locator("a").count(), 0);
  assert.equal(page.url(), initial, "no automatic handoff");
  await page.getByRole("button", { name: "이동", exact: true }).evaluate((button) => button.click());
  assert.equal(page.url(), initial, "synthetic clicks cannot confirm");

  await Promise.all([
    page.waitForURL("about:blank?external-confirm"),
    page.getByRole("button", { name: "이동", exact: true }).click(),
  ]);

  await page.goto(initial);
  await page.getByRole("button", { name: "이동", exact: true }).focus();
  await Promise.all([
    page.waitForURL("about:blank?external-confirm"),
    page.keyboard.press("Enter"),
  ]);

  await page.goto(initial);
  assert.equal(await page.locator(":focus").textContent(), "취소");
  await Promise.all([
    page.waitForURL("about:blank?external-cancel"),
    page.getByRole("button", { name: "취소", exact: true }).click(),
  ]);
});
