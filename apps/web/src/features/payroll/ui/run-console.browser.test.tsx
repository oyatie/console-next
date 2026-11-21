// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog, t } from "@console/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { RunPayslipPreview } from "./run-console-preview";
import type { PayrollRunDetail } from "../domain/run-register";

beforeAll(() => loadCatalog("ko"));

function makeDetail(): PayrollRunDetail {
  return {
    run: {
      id: "00000000-0000-4000-8600-000000000011",
      legal_entity_id: "00000000-0000-4000-8100-000000000001",
      pay_group_id: "00000000-0000-4000-8500-000000000001",
      kind: "REGULAR",
      attribution_month: "2026-10",
      pay_date: "2026-11-25",
      period_start: "2026-10-01",
      period_end: "2026-10-31",
      variable_period_start: "2026-09-16",
      variable_period_end: "2026-10-15",
      source_label: "2026-10",
      status: "CALCULATED",
      calculation_enabled: true,
      created_at: "2026-11-10T09:00:00Z",
      updated_at: "2026-11-10T09:00:00Z",
    },
    legal_basis: {},
    source_summary: {},
    lines: [],
    lines_total: 1,
    lines_limit: 50,
    lines_offset: 0,
    exceptions_open: 0,
    exceptions_total: 0,
    missing_bank_account_count: 0,
    calculation: {
      version: 1,
      calculated_at: "2026-11-10T09:00:00Z",
      calculated_lines: 1,
      blocked_lines: 0,
      payable: false,
      kernel_rate_table: "2026-KR",
      total_gross_won: 3_567_000,
      total_deductions_won: 425_245,
      total_net_won: 3_141_755,
    },
    disbursement: null,
    payslip_delivery: null,
  };
}

test("RunPayslipPreview renders Earnings and Deductions Ledgers without employee_id or fake breakdowns", () => {
  const detail = makeDetail();

  const qc = new QueryClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <RunPayslipPreview
        detail={detail}
        line={{
          id: "00000000-0000-4000-8800-000000000001",
          employee_id: null,
          employee_display_name: "Test Employee",
          employee_company: "Saeon Precision",
          work_days: 22,
          overtime_hours: 12,
          leave_used: 0,
          gross_pay_source_present: true,
          net_pay_source_present: true,
          bank_account_registered: true,
          nts_tax_row_status: "VERIFIED_SOURCE_ROW",
          calculation_status: "READY_FOR_REVIEW",
          blockers: [],
          gross_won: 3_567_000,
          deductions: [
            { code: "NATIONAL_PENSION", label_ko: t("enum.insurer.NPS"), amount_won: 151_515, source_url: "https://example.com" },
          ],
          total_deductions_won: 425_245,
          net_won: 3_141_755,
        }}
      />
    </QueryClientProvider>,
  );

  expect(markup).toContain("3,567,000");
  expect(markup).toContain("151,515");
  expect(markup).toContain("3,141,755");
  expect(markup).toContain("2026-11-25");
  expect(markup).toContain(t("payroll.run.unreviewedPreviewTag"));
  expect(markup).not.toContain(t("payroll.run.openCard"));
});

test("RunPayslipPreview renders directory header metadata and statutory deduction rate notes when available", () => {
  const detail = makeDetail();

  const qc = new QueryClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <RunPayslipPreview
        detail={detail}
        line={{
          id: "00000000-0000-4000-8800-000000000001",
          employee_id: null,
          employee_display_name: "Test Employee",
          employee_company: "Saeon Precision",
          work_days: 22,
          overtime_hours: 12,
          leave_used: 0,
          gross_pay_source_present: true,
          net_pay_source_present: true,
          bank_account_registered: true,
          nts_tax_row_status: "VERIFIED_SOURCE_ROW",
          calculation_status: "READY_FOR_REVIEW",
          blockers: [],
          gross_won: 3_567_000,
          tax_table_version: "2026-10",
          deductions: [
            { code: "NATIONAL_PENSION", label_ko: t("enum.insurer.NPS"), amount_won: 151_515, source_url: "https://example.com" },
            { code: "INCOME_TAX", label_ko: t("payroll.run.col.incomeTax"), amount_won: 98_740, source_url: "https://example.com" },
            { code: "LOCAL_INCOME_TAX", label_ko: t("payroll.run.col.localIncomeTax"), amount_won: 9_870, source_url: "https://example.com" },
          ],
          total_deductions_won: 425_245,
          net_won: 3_141_755,
        }}
        employee={{
          id: "00000000-0000-4000-8300-000000001287",
          company: "Saeon Precision",
          name: "Test Employee",
          employee_number: "10587",
          org_unit: "Plant 1 / Team 1",
          org_unit_id: null,
          legal_entity_id: "00000000-0000-4000-8100-000000000001",
          workplace_id: null,
          position: "Senior Staff",
          home_branch_review_required: false,
          identity_resolution_strategy: "employee_number",
          identity_resolution_confidence: "high",
          identity_review_required: false,
          identity_name_only_merge: false,
          next_event: null,
          failed_event: null,
          created_at: "2026-11-10T09:00:00Z",
          updated_at: "2026-11-10T09:00:00Z",
        }}
        rates={{
          country_code: "KR",
          adopted: true,
          items: [
            {
              code: "NATIONAL_PENSION_EMPLOYEE",
              name: "NPS",
              value: "45/1000",
              status: "ACTIVE",
              effective_from: "2026-01-01",
              effective_to_exclusive: "2027-01-01",
              rate_num: 45,
              rate_den: 1000,
              floor_won: null,
              cap_won: null,
              basis: "PENSION_STANDARD_INCOME",
              bearer: "EMPLOYEE_WHOLE",
              instrument_ko: "Act",
              article_ko: "Art 1",
              promulgation_ko: "No 1",
              enforced_on: "2026-01-01",
              source_url: "https://example.com",
              retrieved_on: "2026-10-01",
              provenance_ko: "Verified",
            },
          ],
        }}
      />
    </QueryClientProvider>,
  );

  expect(markup).toContain("Test Employee 10587");
  expect(markup).toContain("Plant 1 / Team 1");
  expect(markup).toContain("Senior Staff");
  expect(markup).toContain(t("payroll.run.rateNote.taxable", { rate: "4.5" }));
  expect(markup).toContain(t("payroll.run.rateNote.simplifiedTax"));
  expect(markup).toContain(t("payroll.run.rateNote.localIncomeTax", { rate: "10" }));
});
