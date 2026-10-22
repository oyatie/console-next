// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, stepUp, takeCode } from "./flows";
import { tenantInSetup } from "./setup-flows";

async function inviteNamesake(admin: Page, login: string) {
  await go(admin, "/people?view=accounts");
  await admin.getByRole("button", { name: "계정 초대" }).click();
  const sheet = admin.getByRole("dialog", { name: "계정 초대" });
  await sheet.getByRole("button", { name: "직원이 아닌 사람 초대" }).click();
  await sheet.getByRole("textbox", { name: /^이름/ }).fill("권한없음테스트");
  await sheet.getByRole("textbox", { name: /^아이디/ }).fill(login);
  await stepUp(sheet, "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  await takeCode(admin);
}

test("account-only namesakes are distinguishable before bulk selection and each has one readiness action", { tag: "@access" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "access-namesakes", "구별상사", false, "본점", "none");
  await inviteNamesake(admin, "worker1234");
  await inviteNamesake(admin, "worker5678");

  await go(admin, "/access/grants/bulk");
  const people = admin.getByRole("region", { name: "부여할 사람" });
  const rows = people.getByRole("row").filter({ hasText: "권한없음테스트" });
  await expect(rows).toHaveCount(2);
  for (const suffix of ["1234", "5678"]) {
    const row = rows.filter({ hasText: `w••••${suffix}@` });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("동명이인");
    await expect(row).not.toContainText(`worker${suffix}`);
    const visible = await row.getByText(new RegExp(`^w••••${suffix}@`)).evaluate((element, end) => {
      const text = element.firstChild!;
      const start = text.textContent!.indexOf(end);
      const range = new Range();
      range.setStart(text, start);
      range.setEnd(text, start + end.length);
      return range.getBoundingClientRect().right <= element.getBoundingClientRect().right;
    }, suffix);
    expect(visible, "the distinguishing suffix fits before the row is selected").toBe(true);
    await row.getByRole("gridcell").first().click();
    await expect(row).toHaveAttribute("aria-selected", "true");
  }
  await expectAccessible(admin, "namesake bulk selection");

  await go(admin, "/access/ready");
  const targets: string[] = [];
  for (const suffix of ["1234", "5678"]) {
    const label = admin.getByText(new RegExp(`^w••••${suffix}@`));
    await expect(label).toHaveCount(1);
    const row = label.locator("xpath=ancestor::div[strong]/parent::div");
    const action = row.getByRole("link", { name: "권한 부여", exact: true });
    await expect(action).toHaveCount(1);
    const target = await action.getAttribute("href");
    expect(target).toMatch(/^\/access\/people\/[0-9a-f-]+\?grant=true$/);
    targets.push(target!);
    await expect(admin.locator(`a[href="${target}"]`)).toHaveCount(1);
  }
  expect(new Set(targets).size).toBe(2);
  await expectAccessible(admin, "namesake readiness");

  await go(admin, "/access/grants");
  await admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" }).fill("권한없음테스트");
  const options = admin.getByRole("option", { name: /권한없음테스트/ });
  await expect(options).toHaveCount(2);
  await expect(options.filter({ hasText: "w••••1234@" })).toHaveCount(1);
  await expect(options.filter({ hasText: "w••••5678@" })).toHaveCount(1);
  await expectAccessible(admin, "namesake account picker");
  await options.filter({ hasText: "w••••5678@" }).click();
  const sheet = admin.getByRole("dialog", { name: "권한 부여" });
  await expect(sheet).toContainText("w••••5678@");
  await expect(sheet).not.toContainText("w••••1234@");
});
