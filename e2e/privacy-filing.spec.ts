// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { tenantInSetup } from "./setup-flows";
import { chooseRadio, go, registerEmployee, stepUp, firstSignIn, takeCode } from "./flows";
import { fits, expectAccessible } from "./a11y";
import { clearShifts } from "./stability";

test("linked subject files an HR rights request with a real passkey during setup", async ({ browser }) => {
  const { admin, exec } = await tenantInSetup(browser, "rightsco", "모의테스트상사");
  await go(admin, "/account/privacy");
  await expect(admin.getByText("현재 이 계정에서 접수할 수 있는 권리 요구가 없습니다", { exact: true })).toBeVisible();
  await registerEmployee(admin, { name: "김요구", number: "PR-001", unit: "본점" });
  await admin.getByRole("button", { name: "계정 초대" }).click();
  await stepUp(admin.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  const subject = await firstSignIn(browser, await takeCode(admin));
  const optionsResponse = subject.waitForResponse(response => response.url().endsWith("/privacy/rights-requests/options"));
  await go(subject, "/account/privacy");
  const response = await optionsResponse;
  expect(response.ok()).toBe(true);
  const options = await response.json();
  expect(options.controllers).toEqual([{ code: "TENANT" }]);
  expect(options.kinds.map((kind: { code: string }) => kind.code)).not.toContain("AUTOMATED_DECISION");
  await chooseRadio(subject.getByRole("main"), /내 인사 정보/);
  await subject.getByRole("checkbox", { name: /열람/ }).press("Space");
  await subject.getByRole("textbox", { name: /내용/ }).fill("인사 기록");
  for (const theme of ["light", "dark"]) {
    await subject.setViewportSize({ width: 390, height: 844 });
    await subject.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(subject, `privacy filing ${theme}`);
  }
  await expectAccessible(subject, "privacy filing");
  const posted = subject.waitForResponse(r => r.url().endsWith("/privacy/rights-requests") && r.request().method() === "POST");
  await subject.getByRole("button", { name: "요구 접수", exact: true }).click();
  const result = await posted;
  expect(result.ok()).toBe(true);
  const receipt = await result.json();
  expect(receipt.receipt.identity_method).toBe("PASSKEY");
  expect(receipt.kinds.ACCESS.due.on).toBe(options.kinds.find((kind: { code: string }) => kind.code === "ACCESS").due_on);
  await expect(subject.locator("[data-side-panel]").getByRole("heading", { name: receipt.receipt_no, exact: true })).toBeVisible();
  await subject.reload();
  await expect(subject.getByRole("textbox", { name: /내용/ })).toHaveValue("");
  await expect(subject.getByRole("row").filter({ hasText: receipt.receipt_no })).toBeVisible();
  await expect(subject.getByRole("row").filter({ hasText: receipt.receipt_no })).toContainText("접수됨");
  await subject.evaluate(clearShifts);
  await admin.evaluate(clearShifts);
  await go(admin, "/inbox");
  const intake = admin.getByRole("row").filter({ hasText: receipt.receipt_no });
  await expect(intake).toContainText("권리 요구");
  await expect(intake).toContainText("D-10");
  await expect(intake).toContainText("김요구");
  await expect(intake).toContainText("열람");
  await expect(intake.getByRole("link")).toHaveCount(1);
  for (const theme of ["light", "dark"]) {
    await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(admin, `privacy intake ${theme}`);
  }
  await expectAccessible(admin, "privacy intake");
  await intake.getByRole("link").click();
  await expect(admin.getByRole("heading", { name: "권리 요구 접수 내역", exact: true })).toBeVisible();
  await expect(admin.getByText("김요구", { exact: true }).last()).toBeVisible();
  await expect(admin.getByText("인사 기록", { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(admin, `intake receipt ${theme}`);
  }
  await expectAccessible(admin, "intake receipt");
  await subject.context().close();
  await exec.context().close();
  await admin.context().close();
});
