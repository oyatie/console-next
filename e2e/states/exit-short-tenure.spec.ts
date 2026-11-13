// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { fmtDate } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { AT, authz, id } from "../mock/fixtures";
import { mockExitCase } from "../mock/people-exits";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { peopleExitScreens } from "./people-exits";
import { screens } from "./registry";

type Case = components["schemas"]["EmployeeExitCase"];
const path = peopleExitScreens[0].path;
const outcome = (reason: string, num: number, den = 1) => ({ outcome: "NOT_ELIGIBLE", reason, threshold: { num, den } });

async function settlement(page: import("@playwright/test").Page, eligibility: unknown, certification: "UNCERTIFIED_DRAFT" | "CERTIFIED" = "UNCERTIFIED_DRAFT", sources: string[] = []) {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockExitCase(page, "reported");
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz,
    capabilities: [{ feature: "exit_settlement_manage", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }],
  } });
  let c: Case = {
    id: id(7000), employee_id: id(7001), employee_name: "김퇴직", employee_number: "EXIT-001", company: "화면 검증 회사",
    status: "HQ_CONFIRMED", effective_exit_date: "2026-10-26", site_manager_note: "개인 사정",
    involuntary: false, notice_required: false, dismissal_notice: null, protected_periods: [],
    reported_by: id(1), reported_by_name: "김보고", reported_at: AT,
    hr_confirmed_by_name: "김담당", hr_confirmed_at: AT, hq_confirmed_by_name: "김담당", hq_confirmed_at: AT,
    approval_submitted_by_name: null, closed_by_name: null, exit_lifecycle_event_id: null, exit_event_state: "APPLIED",
    next_actions: [{ key: "prepare_settlement" }],
    settlement_package: { id: id(7300), status: "READY_FOR_APPROVAL", service_days: 1,
      missing_source_fields: sources, severance_pay_won: 0, insurance_loss_payload: {}, approval_payload: {}, certification_status: certification, generated_at: AT,
      statutory_basis: { severance_eligibility: eligibility,
        retirement_pay: { authority: "검증 기관", title: "검증 자료", retrieved_on: "2026-07-01", formula: "average_daily_wage * 30 * service_days / 365" },
        insurance_loss: { authority: "검증 기관", title: "보험 상실 자료", retrieved_on: "2026-07-01" },
        calculation_references: { rules: [{ code: "SEVERANCE_MIN_SERVICE_YEARS", effective_from: "2026-07-01", citation: { instrument_ko: "검증 법령", article_ko: "검증 조항" } },
          { code: "SEVERANCE_DAILY_WAGE", effective_from: "2026-07-01", citation: { instrument_ko: "임금 법령", article_ko: "임금 조항" } } ] },
      },
    },
  };
  const sent: unknown[] = [];
  await mockRoute(page, "get", "/api/v1/hr/exit-cases/{id}", () => ({ status: 200, json: c }));
  await mockRoute(page, "post", "/api/v1/hr/exit-cases/{id}/approval-draft", request => {
    const body = request.postDataJSON() as { submit: boolean };
    sent.push(body);
    if (body.submit) c = { ...c, status: "SUBMITTED", next_actions: [], approval_submitted_at: AT, approval_submitted_by_name: "김담당" };
    return { status: 200, json: c };
  });
  return { ...fixture, sent };
}

for (const theme of ["light", "dark"]) for (const [reason, num, den, label] of [
  ["UNDER_SERVICE_YEARS", 2, 1, "근속 2년 미만"],
  ["UNDER_WEEKLY_HOURS", 29, 2, "주 29/2시간 미만"],
] as const) {
  test(`server severance decision ${reason} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await settlement(page, outcome(reason, num, den));
    try {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const figures = page.getByRole("region", { name: "산정 결과", exact: true });
      await expect(figures).toHaveCount(1);
      await expect(figures).toContainText(`퇴직금 미해당 (${label})`);
      await expect(figures).toContainText("노무사 검토 전");
      await figures.locator("summary").click();
      await expect(figures.getByRole("group", { name: "검증 법령 · 검증 조항", exact: true })).toHaveCount(1);
      await expect(figures.getByRole("group", { name: "임금 법령 · 임금 조항", exact: true })).toHaveCount(1);
      await expect(figures).not.toContainText(/retirement_pay|insurance_loss|average_daily_wage/);
      await expect(figures.getByRole("group", { name: "평균임금 (1일)", exact: true })).toHaveCount(0);
      await expect(figures.getByRole("group", { name: "통상임금 (1일)", exact: true })).toHaveCount(0);
      await expect(figures).not.toContainText("0원");
      await expect(figures).toContainText(fmtDate("2026-07-01"));
      await expect(page.getByLabel("평균임금 산정 시작일")).toHaveCount(0);
      await expect(page.getByLabel("월 통상임금")).toHaveCount(0);
      await fits(page, `severance/${reason}/${theme}`);
      await expectAxe(page, `severance/${reason}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("settlement.png"), fullPage: true });
      await page.getByRole("button", { name: "퇴직 정산 1명 계산", exact: true }).click();
      await expect.poll(() => fixture.sent.length).toBe(1);
      expect(fixture.sent[0]).toEqual({ submit: false });
      await page.getByRole("button", { name: "퇴직 정산 1명 결재 요청", exact: true }).click();
      await expect(page.getByRole("main")).toContainText("상신됨");
      expect(fixture.sent).toEqual([{ submit: false }, { submit: true }]);
      await expect(page.getByRole("region", { name: "산정 결과", exact: true })).toHaveCount(1);
      await fits(page, `severance-submitted/${reason}/${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const [reason, num, label] of [
  ["UNDER_SERVICE_YEARS", 1, "근속 1년 미만"],
  ["UNDER_WEEKLY_HOURS", 15, "주 15시간 미만"],
] as const) {
  test(`certified severance decision ${reason} has no pending review @ui-state`, async ({ page }) => {
    const fixture = await settlement(page, outcome(reason, num), "CERTIFIED");
    try {
      await page.goto(path);
      const figures = page.getByRole("region", { name: "산정 결과", exact: true });
      await expect(figures).toContainText(`퇴직금 미해당 (${label})`);
      await expect(figures).not.toContainText("노무사 검토 전");
      await expect(figures).not.toContainText("검증 전 초안");
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const eligibility of [{ outcome: "OPEN" }, outcome("UNDER_SERVICE_YEARS", 0), outcome("UNKNOWN", 1)]) {
  test(`unresolved severance ${JSON.stringify(eligibility)} cannot submit @ui-state`, async ({ page }) => {
    const fixture = await settlement(page, eligibility);
    try {
      await page.goto(path);
      const submit = page.getByRole("button", { name: "퇴직 정산 1명 결재 요청", exact: true });
      await expect(submit).toHaveAttribute("aria-disabled", "true");
      await submit.dispatchEvent("click");
      expect(fixture.sent).toEqual([]);
      await expect(page.getByRole("main")).not.toContainText("퇴직금 미해당");
    } finally { await page.close(); fixture.release(); }
  });
}

test("not applicable settlement is discoverable in the gallery @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  try {
    await page.goto("/_gallery?entry=exit-settlement");
    const gallery = page.locator("#gallery-exit-settlement");
    await expect(gallery).toContainText("퇴직금 미해당 (근속 1년 미만)");
    await expect(gallery).toContainText("노무사 검토 전");
  } finally { await page.close(); fixture.release(); }
});


for (const theme of ["light", "dark"]) test(`missing settlement sources offer repair routes ${theme} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  const sources = ["hire_date", "statutory_rules", "average_wage_period_start", "average_wage_period_end", "average_wage_calendar_days", "average_wage_total_won", "monthly_ordinary_wage_won"];
  const fixture = await settlement(page, { outcome: "OPEN" }, "UNCERTIFIED_DRAFT", sources);
  try {
    await page.goto(path);
    const missing = page.getByRole("region", { name: "계산에 필요한 자료", exact: true });
    await expect(missing.getByRole("link", { name: "입사일 확인·정정", exact: true })).toHaveAttribute("href", `/people/${id(7001)}?act=fix%3Ahire_date`);
    await expect(missing).toContainText("법정 기준 누락 · 관리자에게 퇴직일 기준 법정 기준 대장 검토를 요청하십시오");
    for (const label of ["평균임금 산정 시작일", "평균임금 산정 종료일", "산정 기간 총일수", "기간 임금 총액", "월 통상임금"]) await expect(missing).toContainText(label);
    await page.getByRole("textbox", { name: /^평균임금 산정 시작일/ }).fill("2026-07-01");
    await page.getByRole("textbox", { name: /^평균임금 산정 종료일/ }).fill("2026-09-30");
    await page.getByRole("textbox", { name: /^산정 기간 총일수/ }).fill("92");
    await page.getByRole("textbox", { name: /^기간 임금 총액/ }).fill("9000000");
    await page.getByRole("textbox", { name: /^월 통상임금/ }).fill("3000000");
    await page.getByRole("button", { name: "퇴직 정산 1명 계산", exact: true }).click();
    await expect.poll(() => fixture.sent.length).toBe(1);
    await expect(missing).toContainText("입사일 확인·정정");
    await expect(missing).toContainText("법정 기준 누락 · 관리자에게 퇴직일 기준 법정 기준 대장 검토를 요청하십시오");
    await expect(page.getByRole("button", { name: "퇴직 정산 1명 결재 요청", exact: true })).toHaveAttribute("aria-disabled", "true");
    await fits(page, `missing-sources/${theme}`);
    await expectAxe(page, `missing-sources/${theme}`);
    await missing.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("missing-sources.png"), fullPage: true });
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("malformed exemption never presents zero as the severance decision @ui-state", async ({ page }) => {
  const fixture = await settlement(page, outcome("UNKNOWN", 1));
  try {
    await page.goto(path);
    const figures = page.getByRole("region", { name: "산정 결과", exact: true });
    await figures.locator("summary").click();
    await expect(figures.getByRole("group", { name: "퇴직금 산정액", exact: true })).not.toContainText("0원");
    await expect(figures).not.toContainText(/retirement_pay|insurance_loss|average_daily_wage/);
    await expect(page.getByRole("button", { name: "퇴직 정산 1명 결재 요청", exact: true })).toHaveAttribute("aria-disabled", "true");
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
