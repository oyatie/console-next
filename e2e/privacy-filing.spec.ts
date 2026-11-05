// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { tenantBeforeSetup } from "./setup-flows";
import { chooseRadio, go } from "./flows";
import { fits, expectAccessible } from "./a11y";
import { clearShifts } from "./stability";

test("subject files an account rights request with a real passkey during setup", async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "rightsco", "모의테스트상사");
  const optionsResponse = admin.waitForResponse(response => response.url().endsWith("/privacy/rights-requests/options"));
  await go(admin, "/account/privacy");
  const response = await optionsResponse;
  expect(response.ok()).toBe(true);
  const options = await response.json();
  expect(options.controllers).toEqual([{ code: "OPERATOR" }]);
  expect(options.kinds.map((kind: { code: string }) => kind.code)).not.toContain("AUTOMATED_DECISION");
  await chooseRadio(admin.getByRole("main"), /내 계정 정보/);
  await admin.getByRole("checkbox", { name: /열람/ }).press("Space");
  await admin.getByRole("textbox", { name: /내용/ }).fill("계정의 로그인 기록");
  for (const theme of ["light", "dark"]) {
    await admin.setViewportSize({ width: 390, height: 844 });
    await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(admin, `privacy filing ${theme}`);
  }
  await expectAccessible(admin, "privacy filing");
  const posted = admin.waitForResponse(r => r.url().endsWith("/privacy/rights-requests") && r.request().method() === "POST");
  await admin.getByRole("button", { name: "요구 접수", exact: true }).click();
  const result = await posted;
  expect(result.ok()).toBe(true);
  const receipt = await result.json();
  expect(receipt.receipt.identity_method).toBe("PASSKEY");
  expect(receipt.kinds.ACCESS.due.on).toBe(options.kinds.find((kind: { code: string }) => kind.code === "ACCESS").due_on);
  await expect(admin.locator("[data-side-panel]").getByRole("heading", { name: receipt.receipt_no, exact: true })).toBeVisible();
  await admin.reload();
  await expect(admin.getByRole("textbox", { name: /내용/ })).toHaveValue("");
  await expect(admin.getByRole("row").filter({ hasText: receipt.receipt_no })).toBeVisible();
  await expect(admin.getByRole("row").filter({ hasText: receipt.receipt_no })).toContainText("접수됨");
  await admin.evaluate(clearShifts);
  await go(admin, "/inbox");
  const intake = admin.getByRole("row").filter({ hasText: receipt.receipt_no });
  await expect(intake).toContainText("권리 요구");
  await expect(intake).toContainText("D-10");
  for (const theme of ["light", "dark"]) {
    await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(admin, `privacy intake ${theme}`);
  }
  await expectAccessible(admin, "privacy intake");
  await admin.context().close();
});
