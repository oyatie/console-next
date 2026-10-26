// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible, fits } from "./a11y";
import { clearShifts, forgetResize } from "./stability";
import { go, registerEmployee } from "./flows";
import { SETUP_DEPARTMENT, setupCompany, setupRail, tenantBeforeSetup } from "./setup-flows";
import { addDepts, openUnit, sheet } from "./helpers/structure";

test("staffed people at 사업장 직속 block go-live even when a department exists", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "deptcomplete", "부서배치", false, "none");
  await setupCompany(admin, "부서배치", "본점");
  const names = ["김부서", "이부서", "박부서"];
  for (const name of names) await registerEmployee(admin, { name, unit: "본점" });
  await go(admin, "/");
  await expect(setupRail(admin)).toContainText("부서 없는 직원 3명");
  await expect(setupRail(admin).getByRole("link", { name: "부서 지정", exact: true })).toHaveAttribute("href", "/people?review=department");
  for (const width of [1440, 390]) {
    await go(admin, "/");
    await admin.setViewportSize({ width, height: 900 });
    await forgetResize(admin);
    const preview = admin.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/onboarding/go-live/preview" && r.ok());
    await go(admin, "/setup/go-live");
    await preview;
    const blocker = admin.getByRole("alert", { name: "부서 없는 직원 3명", exact: true });
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText("people_without_department");
    for (const name of names) await expect(blocker.getByText(name, { exact: true })).toBeVisible();
    await expect(blocker.getByRole("grid").getByRole("columnheader", { name: "직원", exact: true })).toBeVisible();
    await expect(blocker.getByRole("link", { name: "부서 지정", exact: true })).toHaveCount(1);
    await expect(admin.getByRole("button", { name: "운영 시작", exact: true })).toBeDisabled();
    await admin.evaluate(clearShifts);
    await expectAccessible(admin, `department readiness at ${width}`);
    if (width === 390) await fits(admin, "department readiness");
  }

  await admin.getByRole("alert", { name: "부서 없는 직원 3명", exact: true }).getByRole("link", { name: "부서 지정", exact: true }).click();
  await expect(admin).toHaveURL(/\/people\?review=department$/);
  await expect(admin.getByRole("button", { name: "부서 없음 3", exact: true })).toHaveAttribute("aria-pressed", "true");
  const table = admin.getByRole("grid", { name: "직원", exact: true });
  for (const name of names) await expect(table.getByText(name, { exact: true })).toBeVisible();
  await table.getByRole("row").first().locator("label", { has: admin.getByRole("checkbox") }).click();
  await admin.getByRole("button", { name: "선택한 3명 일괄 발령" }).click();
  await admin.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "전보", exact: true }).click();
  await admin.getByRole("listbox", { name: "어디로" }).getByRole("option", { name: new RegExp(`^${SETUP_DEPARTMENT}`) }).click();
  await admin.getByRole("button", { name: /오늘/ }).click();
  await admin.getByRole("radiogroup", { name: /^사유/ }).getByText("조직 개편", { exact: true }).click();
  await admin.getByRole("textbox", { name: /^메모/ }).fill("설정 단계 부서 배치");
  await admin.getByRole("button", { name: "전보 3명 반영", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "3명 전보 반영함" })).toBeVisible();
  await go(admin, "/setup/go-live");
  await expect(admin.getByRole("button", { name: "운영 시작", exact: true })).toBeVisible();
  await expect(admin.getByRole("alert", { name: "부서 없는 직원 3명", exact: true })).toHaveCount(0);
});

test("department vacancy count appoints a head directly from the list and panel", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "deptheads", "부서장지정", false, "none");
  await setupCompany(admin, "부서장지정", "본점");
  await addDepts(admin, "본점", ["품질팀"]);
  await registerEmployee(admin, { name: "김부서장", unit: SETUP_DEPARTMENT });
  await go(admin, "/org?view=list");
  const filter = admin.getByRole("button", { name: "부서장 없음 2", exact: true });
  await expect(filter).toBeVisible();
  await filter.click();
  const row = admin.getByRole("row").filter({ hasText: SETUP_DEPARTMENT });
  await row.getByRole("button", { name: "부서장 지정", exact: true }).click();
  const appoint = sheet(admin, "부서장 지정");
  const picker = appoint.getByRole("combobox", { name: "부서장", exact: true });
  await expect(picker).toBeFocused();
  await picker.press("ArrowDown");
  await admin.getByRole("option", { name: /김부서장/ }).click();
  await appoint.getByRole("button", { name: "부서 정보 1개 변경", exact: true }).click();
  await expect(appoint).toBeHidden();
  await expect(admin.getByRole("button", { name: "부서장 없음 1", exact: true })).toBeVisible();
  // Removing the last vacant head while the filter is active must keep the chip usable.
  await admin.getByRole("button", { name: "부서장 없음 1", exact: true }).click();
  await expect(admin.getByRole("grid")).toContainText("김부서장");
  for (const width of [1440, 390]) {
    await admin.setViewportSize({ width, height: 900 });
    await forgetResize(admin);
    await expectAccessible(admin, `department heads list ${width}`);
  }
  await admin.setViewportSize({ width: 1440, height: 900 });
  await go(admin, "/org");
  const panel = await openUnit(admin, "품질팀");
  await panel.getByRole("button", { name: "부서장 지정", exact: true }).click();
  await expect(appoint.getByRole("combobox", { name: "부서장", exact: true })).toBeFocused();
  await appoint.getByRole("button", { name: "닫기", exact: true }).last().click();
  for (const width of [1440, 390]) {
    await admin.setViewportSize({ width, height: 900 });
    await forgetResize(admin);
    await expectAccessible(admin, `department heads panel ${width}`);
  }
});
