// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { forgetResize } from "./stability";
import { apiOf, bearerOf } from "./helpers/api";
import { cellOf, officeSchedule, openMonth, pastWorkDay } from "./helpers/attendance-records";
import { chooseRadio, firstSignIn, go, kstDate, registerEmployee, takeCode, tenantOnboardSubmit, tenantSlugField, unique, vendorPage } from "./flows";
import { SETUP_DEPARTMENT, setupCompany, startOperations } from "./setup-flows";

// Slice 1: the paid-time rule, before approval storage and disposition screens land.
test("unapproved worked time is recognised immediately for a solo administrator", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(600_000);
  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설" }).click();
  await vendor.getByLabel("고객 이름").fill("근로시간인정주식회사");
  await tenantSlugField(vendor).fill(unique("attpaid"));
  await tenantOnboardSubmit(vendor).click();
  const admin = await firstSignIn(browser, await takeCode(vendor));
  const bearer = bearerOf(admin);
  await setupCompany(admin, "근로시간인정주식회사", "본사");
  await startOperations(admin);
  await registerEmployee(admin, { name: "윤하준", number: "R-0001", unit: SETUP_DEPARTMENT, hired: kstDate(-60) });
  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const response = await api("/employees?limit=10");
  expect(response.status()).toBe(200);
  const people = await response.json() as { items: { id: string; name: string }[] };
  const employeeId = people.items.find((p) => p.name === "윤하준")!.id;
  const { month, date } = await pastWorkDay(api, employeeId);
  const grid = await openMonth(admin, month);
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.type("9-20");
  await admin.keyboard.press("Enter");
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await chooseRadio(save, /출근부 \(종이\)/);
  await save.getByRole("button", { name: "1칸 저장", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();
  await expect(cellOf(admin, "윤하준", date)).toContainText("10");
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.press("p");
  const dock = admin.getByRole("complementary", { name: /하루 기록/ });
  await expect(dock.getByText("10:00 · 소정 안 8:00", { exact: true })).toBeVisible();
  await expect(dock.getByText("2:00 · 미승인 초과 2:00", { exact: true })).toBeVisible();
  await expect(dock.getByText("승인이 없어도 근로시간으로 인정 · 마감 전에 처리", { exact: true })).toBeVisible();
  await expectAccessible(admin, "paid time dock");
  for (const width of [1440, 390]) {
    await admin.setViewportSize({ width, height: 1000 });
    await forgetResize(admin);
    await expectAccessible(admin, `paid time ${width}`);
  }
  await admin.context().close();
});
