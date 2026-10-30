// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { fmtDate } from "@console/i18n/format";
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { AT, id } from "../mock/fixtures";
import { moveDetail } from "../mock/lifecycle-sheets";
import { mockRoute } from "../mock/route";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

test.beforeAll(() => loadCatalog("ko"));

// Additive response pending backend projection of the existing command guard.
const refusedEvent: components["schemas"]["EmployeeLifecycleEvent"] & { action_refusals: { correct: string } } = {
  id: id(4052), employee_id: id(4000), event_type: "TRANSFER", state: "SCHEDULED", to_status: "ACTIVE", effective_date: "2027-03-01",
  comment: "", created_by: id(1), created_by_name: "김담당", created_at: AT,
  signoffs: { privacy_notice_ack: true, korean_labor_law_ack: true, payroll_cutoff_ack: false, retirement_settlement_ack: false },
  action_refusals: { correct: "lifecycle_void_exit_owned" },
};

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`lifecycle dates use the shared display format ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 200, json: {
      ...moveDetail, employee: { ...moveDetail.employee, status: "ON_LEAVE", hire_date: "2020-03-02" },
      allowed_events: [{ event_type: "RETURN_FROM_LEAVE", required_signoffs: [] }],
    } });
    await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-events", { status: 200, json: { items: [{
      id: id(4051), employee_id: id(4000), event_type: "LEAVE_OF_ABSENCE", state: "APPLIED", to_status: "ON_LEAVE",
      effective_date: "2026-03-01", expected_return_date: "2027-02-28", leave_type: "CHILDCARE", comment: "", created_by: id(1), created_by_name: "김담당", created_at: AT,
      signoffs: { privacy_notice_ack: true, korean_labor_law_ack: true, payroll_cutoff_ack: false, retirement_settlement_ack: false },
    }], head_version: 1, next_cursor: null } });
    await page.goto(`/people/${id(4000)}?act=RETURN_FROM_LEAVE`);
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    const sheet = page.getByRole("dialog", { name: t("lifecycle.title.RETURN_FROM_LEAVE"), exact: true });
    await expect(sheet).toContainText(t("lifecycle.nowSince", { where: `본사 › ${t("lifecycle.changes.siteDirect")}`, date: fmtDate("2020-03-02") }));
    await expect(sheet).toContainText(fmtDate("2026-03-01"));
    await expect(sheet).toContainText(fmtDate("2027-02-28"));
    await expect(sheet).not.toContainText(/2020-03-02|2026-03-01|2027-02-28/);
    await fits(page, `people-dates/${width}/${theme}`);
    await expectAxe(page, `people-dates/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`server correction refusal is authoritative ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-events", { status: 200, json: { items: [refusedEvent], head_version: 1, next_cursor: null } });
    await page.goto(`/people/${id(4000)}?act=correct:${id(4052)}`);
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    const notice = page.getByRole("status").filter({ hasText: t("person.act.unavailable") });
    await expect(notice).toContainText(t("person.act.unavailable.lifecycle_void_exit_owned"));
    await expect(notice.getByText("lifecycle_void_exit_owned", { exact: true })).toBeVisible();
    await fits(page, `server-correction-refusal/${width}/${theme}`);
    await expectAxe(page, `server-correction-refusal/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}
