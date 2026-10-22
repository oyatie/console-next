// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { chooseRadio, go, kstDate, submitRegistration } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openSchedule } from "./helpers/attendance";
import { cellOf, officeSchedule, openMonth, pastWorkDay } from "./helpers/attendance-records";
import { pressRegister, registerSheet } from "./helpers/register";
import { SETUP_DEPARTMENT, tenantInSetup } from "./setup-flows";
import { revealUnit } from "./structure-flows";

async function pickNamesake(page: Page, label: string, count = 3) {
  await page.getByRole("combobox", { name: label, exact: true }).clear();
  await page.getByRole("combobox", { name: label, exact: true }).fill("선택동명");
  const options = page.getByRole("option", { name: /선택동명/ });
  await expect(options).toHaveCount(count);
  for (const code of ["PK-0002", "PK-0003"]) {
    const option = options.filter({ hasText: code });
    await expect(option).toContainText("동명이인");
    await expect(option).toContainText(SETUP_DEPARTMENT);
    await expect(option.getByRole("link")).toHaveCount(0);
  }
  await expectAccessible(page, `${label}: open namesake picker`);
  await options.filter({ hasText: "PK-0002" }).click();
  await page.getByRole("textbox", { name: /선택한 사람의 사번 끝/ }).fill("0002");
}

test("person labels and deliberate namesake selection work in all five adopted product pickers", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await tenantInSetup(browser, "personpickers", "선택상사", false, "본점", "none");
  const bearer = bearerOf(admin);
  let first = "";
  for (const number of ["PK-0001", "PK-0002", "PK-0003"]) {
    await submitRegistration(admin, { name: "선택동명", number, unit: SETUP_DEPARTMENT, hired: kstDate(-60) });
    if (first) {
      await chooseRadio(registerSheet(admin), /다른 사람입니다 · 동명이인으로 등록/);
      await chooseRadio(registerSheet(admin).getByRole("radiogroup", { name: /^동명이인으로 등록하는 사유/ }), /^기타$/);
      await registerSheet(admin).getByRole("textbox", { name: /^사유 설명/ }).fill("사번이 다른 별도 직원");
      await pressRegister(admin);
    }
    const receipt = admin.getByRole("status").filter({ hasText: `사번 ${number}` });
    await expect(receipt).toBeVisible();
    if (!first) first = (await receipt.getByRole("link", { name: "인사카드 열기" }).getAttribute("href"))!;
  }

  await openSchedule(admin);
  await pickNamesake(admin, "사람 찾기 — 이름·사번");
  await expect(admin).toHaveURL(/kind=PERSON/);

  await admin.getByRole("tab", { name: /근무조/ }).click();
  await admin.getByRole("button", { name: "근무조 추가", exact: true }).first().click();
  const crew = admin.getByRole("dialog", { name: "근무조 추가", exact: true });
  await crew.getByRole("combobox", { name: /^사업장/ }).selectOption({ label: "본점" });
  await crew.getByRole("textbox", { name: /^이름/ }).fill("선택조");
  await crew.getByRole("button", { name: "근무조 추가", exact: true }).click();
  await admin.getByRole("button", { name: "사람 추가", exact: true }).click();
  await pickNamesake(admin, "사람");
  const members = admin.getByRole("dialog", { name: "사람 추가", exact: true });
  await expect(members.getByRole("link", { name: /선택동명.*PK-0002/ })).toBeVisible();
  await members.getByRole("button", { name: "닫기", exact: true }).first().click();

  await go(admin, "/org");
  await revealUnit(admin, SETUP_DEPARTMENT);
  await admin.locator("#act-dept-head").click();
  await pickNamesake(admin, "부서장");
  await expect(admin.getByRole("complementary", { name: SETUP_DEPARTMENT, exact: true }).getByRole("link", { name: /선택동명.*PK-0002/ })).toBeVisible();

  // Inspect the existing identity sheet without committing an irreversible merge.
  await go(admin, `${first}?act=identity`);
  const identity = admin.getByRole("dialog", { name: "선택동명 동일인 확인" });
  await chooseRadio(identity, /같은 사람입니다/);
  await pickNamesake(admin, "남길 기록", 2);
  await expect(identity.getByRole("link", { name: /선택동명.*PK-0002/ })).toBeVisible();
  await identity.getByRole("button", { name: "취소", exact: true }).click();

  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const { month, date } = await pastWorkDay(api, first.split("/").at(-1)!);
  const grid = await openMonth(admin, month);
  await cellOf(admin, "선택동명", date).first().click();
  await admin.keyboard.type("9-18");
  await admin.keyboard.press("Enter");
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const evidence = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await chooseRadio(evidence, /관리자 확인 · 확인자 지정/);
  await pickNamesake(admin, "확인자");
  await expect(evidence.getByRole("link", { name: /선택동명.*PK-0002/ })).toBeVisible();
});
