// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { apiOf, bearerOf } from "./helpers/api";

test("2027 payroll reads dated citations and keeps missing statutory inputs unissuable", { tag: ["@hr", "@negative", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await staffedTenant(browser, "rates27", "법정요율검토상사");
  const api = apiOf(admin, bearerOf(admin));
  await registerEmployee(admin, { name: "요율검토직원", number: "RATES-27", hired: "2026-01-01", unit: "본사" });
  const id = new URL(admin.url()).pathname.split("/").pop()!;
  await go(admin, `/people/${id}`);
  const response = await api(`/payroll/employees/${id}/payslip-draft?period=2027-01&pay_date=2027-01-10`);
  expect(response.status()).toBe(200);
  const draft = await response.json();
  expect(draft.issuable).toBe(false);
  const citations = draft.statutory_citations as { code: string; rate_num: number | null; rate_den: number | null; floor_won: number | null; cap_won: number | null; effective_from: string; effective_to_exclusive: string; promulgation_ko: string }[];
  expect(citations.find((row) => row.code === "NATIONAL_PENSION_EMPLOYEE")).toMatchObject({ rate_num: 500, rate_den: 10000, effective_from: "2027-01-01", effective_to_exclusive: "2028-01-01", promulgation_ko: "법률 제22096호" });
  expect(citations.find((row) => row.code === "HEALTH_INSURANCE_TOTAL")).toMatchObject({ rate_num: 719, rate_den: 10000, promulgation_ko: "대통령령 제36675호" });
  expect(citations.find((row) => row.code === "MINIMUM_WAGE")).toMatchObject({ floor_won: 10700, cap_won: 2236300, promulgation_ko: "고용노동부고시 제2026-60호 (발령 2026. 8. 5.)" });
  expect(citations.find((row) => row.code === "EMPLOYMENT_INSURANCE_EMPLOYEE")).toMatchObject({ rate_num: 9, rate_den: 1000, promulgation_ko: "대통령령 제35935호" });
  for (const code of ["LONG_TERM_CARE_TOTAL", "HEALTH_PREMIUM_BAND", "SIMPLIFIED_WITHHOLDING_TABLE"]) {
    expect(citations.find((row) => row.code === code)).toBeUndefined();
  }
});
