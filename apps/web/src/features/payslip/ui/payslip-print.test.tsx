// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { parsePayslipPayload } from "../domain/payslip";
import { buildPayslipPrintHtml } from "./payslip-print";

beforeAll(() => loadCatalog("ko"));

const slip = {
  attribution_month: "2026-10",
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  pay_date: "2026-11-25",
  employee_number: "10587",
  employee_display_name: '<script>alert("xss")</script>',
  employee_company: 'Saeon <img src=x onerror="alert(1)">',
  org_unit: "Line 1",
  position: "Lead",
  work_days: 18,
  paid_holiday_days: 4,
  overtime_hours: 12,
  leave_used: 0,
  base_pay_won: 3_100_000,
  overtime_pay_won: 267_000,
  meal_allowance_won: 200_000,
  gross_won: 3_567_000,
  deductions: [{ code: "NATIONAL_PENSION", amount_won: 151_515 }],
  total_deductions_won: 425_245,
  net_won: 3_141_755,
};

test("buildPayslipPrintHtml escapes hostile strings and formats payslip tables cleanly", () => {
  const payload = parsePayslipPayload(slip);
  expect(payload).not.toBeNull();
  const html = buildPayslipPrintHtml(payload!, "2026-10");
  expect(html).toContain("<!doctype html>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  expect(html).toContain("3,141,755");
  expect(html).toContain("3,567,000");
  expect(html).toContain("425,245");
  expect(html).toContain('href="/payslip-print.css"');
});

test("the printed payslip keeps the locale date form whatever day style the screen draws", () => {
  const screenStyle = i18n.dateStyle;
  i18n.dateStyle = () => "iso";
  try {
    expect(fmtDate("2026-10-01")).toBe("2026-10-01");
    const html = buildPayslipPrintHtml(parsePayslipPayload(slip)!, "2026-10");
    expect(html).toContain("2026. 10. 01.");
    expect(html).toContain("2026. 10. 31.");
    expect(html).toContain("2026. 11. 25.");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  } finally {
    i18n.dateStyle = screenStyle;
  }
});
