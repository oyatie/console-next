// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Locator, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible } from "./a11y";
import { go, koDate, kstDate, registerEmployee } from "./flows";
import { openUnit, panel, sheet } from "./helpers/structure";
import { openTenant } from "./helpers/tenant";
import { SETUP_DEPARTMENT, setupCompany, startOperations } from "./setup-flows";
import { leaveScreen, revealUnit } from "./structure-flows";

async function datedLabels(page: Page, date: string, mode: "과거" | "예정", entity = false) {
  const main = page.getByRole("main");
  await expect(main).not.toContainText(/오늘\(|지금 상태|지금 재직/);
  const control = main.getByRole("region", { name: "기준일", exact: true });
  const band = control.locator('[data-placement="page"]');
  await expect(band.locator("strong")).toHaveText(`${koDate(date)} 기준 · ${mode}${entity && mode === "과거" ? " · 그날 등록증 기준" : ""}`);
  await expect(band).not.toContainText("읽기 전용");
  await expect(band.getByRole("button", { name: "오늘로", exact: true })).toBeVisible();
}

async function readOnlyPanel(selected: Locator, date: string) {
  await expect(selected).toBeVisible();
  await expect(selected).toContainText(`${koDate(date)} 기준`);
  await expect(selected.getByRole("button", { name: /부서 추가|이름 변경|부서장 지정|사업장 종료|부서 폐지|수정/ })).toHaveCount(0);
  await expect(selected.getByRole("heading", { name: "이력", exact: true })).toBeVisible();
}

async function accessibleAtBothWidths(page: Page, label: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await leaveScreen(page);
  await expectAccessible(page, `${label}, 1440px`);
  await atPhoneWidth(page, async () => {
    await leaveScreen(page);
    await expectAccessible(page, `${label}, 390px`);
  });
}

test("past and future views keep dated labels and readable inspectors; future changes inherit the date", {
  tag: ["@org", "@hr", "@regression", "@first-run"],
}, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "asof-integrity", "기준일상사");
  await setupCompany(admin, "기준일상사", "본사");
  const entityRecord = new URL(admin.url()).pathname;
  await registerEmployee(admin, { name: "시점구성원", number: "ASOF-0001", unit: SETUP_DEPARTMENT, hired: kstDate(-30) });
  await openUnit(admin, SETUP_DEPARTMENT);
  const department = new URL(admin.url()).searchParams.get("sel")!;
  await openUnit(admin, "본사");
  const workplace = new URL(admin.url()).searchParams.get("sel")!;
  await startOperations(admin);
  const past = kstDate(-1), future = kstDate(3), today = kstDate();

  await go(admin, `/org?as_of=${past}&sel=${workplace}`);
  await datedLabels(admin, past, "과거");
  await expect(admin.getByRole("main").getByText(`${past} 기준 구조입니다`, { exact: false })).toBeVisible();
  await readOnlyPanel(panel(admin, "본사"), past);
  await accessibleAtBothWidths(admin, "past workplace inspector");

  await go(admin, `${entityRecord}?as_of=${past}`);
  await datedLabels(admin, past, "과거", true);
  await expect(admin.getByRole("heading", { name: `${koDate(past)} 기준 상태`, exact: true })).toBeVisible();
  await expect(admin.getByRole("main").getByText(`${koDate(past)} 재직 1명`, { exact: false }).first()).toBeVisible();
  await accessibleAtBothWidths(admin, "past entity record");

  const members = admin.waitForResponse((r) => r.request().method() === "GET"
    && new URL(r.url()).pathname === `/api/v1/org-structure/units/${department}/members`
    && new URL(r.url()).searchParams.get("as_of") === future);
  await go(admin, `/org?as_of=${future}&sel=${department}`);
  await datedLabels(admin, future, "예정");
  await readOnlyPanel(panel(admin, SETUP_DEPARTMENT), future);
  expect((await members).status()).toBe(200);
  await expect(panel(admin, SETUP_DEPARTMENT)).toContainText("시점구성원");
  await expect(admin.getByRole("main").getByText(`${future} 기준 구조입니다`, { exact: false })).toBeVisible();
  await accessibleAtBothWidths(admin, "future department inspector");

  await go(admin, `/org?compare_a=${today}&compare_b=${future}&sel=${department}`);
  await readOnlyPanel(panel(admin, SETUP_DEPARTMENT), future);
  await expect(panel(admin, SETUP_DEPARTMENT)).toContainText("시점구성원");
  await expect(admin.getByRole("button", { name: "이 날짜로 조직 변경 작성", exact: true })).toHaveCount(0);

  await go(admin, `/org?as_of=${future}`);
  await revealUnit(admin, "본사");
  await admin.getByRole("button", { name: "이 날짜로 조직 변경 작성", exact: true }).click();
  const proposal = sheet(admin, "본사 아래에 부서 신설");
  await expect(proposal).toBeVisible();
  await expect(proposal.getByRole("textbox", { name: /^시행일/ })).toHaveValue(koDate(future));
  await proposal.getByRole("button", { name: "닫기", exact: true }).last().click();
  await datedLabels(admin, future, "예정");
});
