// SPDX-License-Identifier: LicenseRef-Proprietary
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { signOff } from "../e2e/sheet";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); });

test("sign-off waits for the confirmation group before ticking each statement", async () => {
  const group = page.getByRole("group", { name: "Confirmations" });
  const signing = signOff(group);
  expect(await group.count()).toBe(0);
  await page.setContent('<fieldset><legend>Confirmations</legend><label><input type="checkbox">First statement</label><label><input type="checkbox">Second statement</label></fieldset>');
  await signing;
  expect(await group.getByRole("checkbox", { name: "First statement" }).isChecked()).toBe(true);
  expect(await group.getByRole("checkbox", { name: "Second statement" }).isChecked()).toBe(true);
  await page.setContent('<fieldset><legend>No confirmations</legend></fieldset>');
  await signOff(page.getByRole("group", { name: "No confirmations" }));
});
