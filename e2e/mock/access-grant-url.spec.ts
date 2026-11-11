// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { AT } from "./fixtures";
import { mockRoute } from "./route";
import { accessScreens, mockAccessScreen } from "../states/access";

test.beforeAll(() => loadCatalog("ko"));

test("the grant sheet is open exactly while the link says so: the button, back, forward and close agree", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await mockAccessScreen(page, accessScreens[0], "populated");
  const account = f.accounts[0]!;
  await mockRoute(page, "get", "/api/v1/access/accounts/{accountId}/effective", { status: 200, json: { account_id: account.id, is_ops: false, phase: "OPERATING", as_of: AT, entries: [] } });
  await page.goto(`/access/people/${account.id}`);
  const sheet = page.getByRole("dialog", { name: t("access.grant.title") });
  await expect(sheet).toHaveCount(0);
  await page.getByRole("main").getByRole("button", { name: t("access.grant.title"), exact: true }).click();
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/grant=true/);
  // Back closes it and forward opens it again: the screen follows the address, not a flag read once on arrival.
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(page).not.toHaveURL(/grant=/);
  await page.goForward();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).not.toHaveURL(/grant=/);
  // A link that names the sheet opens it on arrival, as before.
  await page.goto(`/access/people/${account.id}?grant=true`);
  await expect(sheet).toBeVisible();
});
