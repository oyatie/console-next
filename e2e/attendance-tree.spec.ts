// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { chooseRadio, go, kstDate, registerEmployee } from "./flows";
import { fillWeeklyPattern, openSchedule } from "./helpers/attendance";
import { startOperations, tenantInSetup } from "./setup-flows";
import { addDepartments } from "./structure-flows";
import { sheet } from "./sheet";
import { clearShifts } from "./stability";

test("scope counts lead by keyboard to the same unscheduled people and update after assignment", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "atttree", "일정범위주식회사", false, "판교지점");
  await admin.setViewportSize({ width: 1440, height: 900 });
  await go(admin, "/org");
  await addDepartments(admin, "판교지점", ["영업1팀", "영업2팀"]);
  await startOperations(admin);
  for (const [name, number] of [["윤하준", "TREE-1"], ["황정우", "TREE-2"], ["송재원", "TREE-3"]]) {
    await registerEmployee(admin, { name: name!, number: number!, unit: "영업1팀", hired: kstDate(-60) });
  }
  for (const [name, number] of [["김서연", "TREE-4"], ["이도윤", "TREE-5"]]) {
    await registerEmployee(admin, { name: name!, number: number!, unit: "영업2팀", hired: kstDate(-60) });
  }
  await openSchedule(admin);
  const tree = admin.getByRole("treegrid", { name: "범위 (법인 › 사업장 › 부서)" });
  const workplace = tree.getByRole("row", { name: /^판교지점/ });
  await expect(workplace).toContainText("일정 없음 5명");
  await expect(workplace).not.toContainText("따름");
  await admin.evaluate(clearShifts);
  await expectAccessible(admin, "schedule scope tree at 1440px");
  await atPhoneWidth(admin, async () => {
    await expectAccessible(admin, "schedule scope tree at 390px");
    await fits(admin, "schedule scope tree");
  });

  // Arrow into the selected row, then Tab reaches its link without selecting another scope.
  await workplace.focus();
  await admin.keyboard.press("ArrowRight");
  await admin.keyboard.press("Tab");
  const count = workplace.getByRole("link", { name: "일정 없음 5명", exact: true });
  await expect(count).toBeFocused();
  await admin.keyboard.press("Enter");
  await expect(admin).toHaveURL(/wp=.+unscheduled=(true|1)|unscheduled=(true|1).+wp=/);
  await expect(admin.getByRole("button", { name: "일정 지정", exact: true })).toHaveCount(5);
  await openSchedule(admin);
  await workplace.focus();
  await admin.keyboard.press("ArrowRight");
  const department = tree.getByRole("row", { name: /^영업1팀/ });
  await expect(department).toContainText("일정 없음 3명");
  await department.getByRole("link", { name: "일정 없음 3명", exact: true }).click();
  await expect(admin).toHaveURL(/unit=/);
  await expect(admin).toHaveURL(/wp=/);
  await expect(admin.getByRole("button", { name: "일정 지정", exact: true })).toHaveCount(3);
  for (const name of ["김서연", "이도윤"]) await expect(admin.getByRole("link", { name, exact: true })).toHaveCount(0);
  for (const name of ["윤하준", "황정우", "송재원"]) await expect(admin.getByRole("link", { name, exact: true })).toBeVisible();

  await admin.getByRole("button", { name: "일정 지정", exact: true }).first().click();
  const pattern = sheet(admin, "근무 유형 추가");
  await fillWeeklyPattern(pattern, "사무 일정", ["09:00", "18:00", "12:00", "13:00"]);
  await pattern.getByRole("button", { name: "사무 일정 추가" }).click();
  const assign = sheet(admin, "근무 일정 지정");
  await assign.getByRole("combobox", { name: /^근무 유형/ }).selectOption({ label: "사무 일정" });
  await assign.getByRole("textbox", { name: /^적용 시작일/ }).fill(kstDate());
  await chooseRadio(assign, /기본 일정/);
  await assign.getByRole("button", { name: /^1명에게 .+부터 적용$/ }).click();
  await expect(admin.getByRole("button", { name: "일정 지정", exact: true })).toHaveCount(2);
  await admin.getByRole("navigation", { name: "근태 화면" }).getByRole("link", { name: "근무 일정" }).click();
  await expect(workplace.getByRole("link", { name: "일정 없음 4명", exact: true })).toBeVisible();
  await expect(department.getByRole("link", { name: "일정 없음 2명", exact: true })).toBeVisible();
  await expect(department).toContainText("3명");
});
