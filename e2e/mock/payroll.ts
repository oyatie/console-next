// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { PayGroups, PayrollRate, PayrollRates, PayrollRun } from "@console/api/pending";
import type { PayrollState } from "../states/payroll";
import { AT, failure, id } from "./fixtures";
export const rate: PayrollRate = {
  code: "SYNTHETIC", name: "모의 기준", value: "0.123456%", status: "ACTIVE", effective_from: "2026-01-01", effective_to_exclusive: "2027-01-01",
  rate_num: 123456, rate_den: 100000000, floor_won: null, cap_won: null, basis: "SYNTHETIC", bearer: "SYNTHETIC",
  instrument_ko: "모의 고시", article_ko: "모의 조문", promulgation_ko: "모의 제1호", enforced_on: "2026-01-01", source_url: "https://example.com/payroll-source", retrieved_on: "2026-10-29", provenance_ko: "화면 검증용 가상 기준 · 실제 계산에 사용하지 않음",
};
const runStatuses = ["STAGED", "BLOCKED_LEGAL_GATE", "READY_FOR_REVIEW", "ATTENDANCE_CLOSED", "CALCULATING", "CALCULATED", "SUBMITTED", "REJECTED", "APPROVED", "DISBURSEMENT_SCHEDULED", "PAID", "ISSUED", "VOID"] as const satisfies readonly PayrollRun["status"][];
export const payGroups: PayGroups = {
  legal_entities: [{ id: id(800), name: "모의상사", country_code: "KR" }, { id: id(801), name: "모의상사 해외법인", country_code: "US" }],
  items: [0, 1, 2].map(n => ({ id: id(810 + n), legal_entity_id: id(n < 2 ? 800 : 801), name: `모의 급여 그룹 ${n + 1}`, next_pay_date: "2026-11-25", pay_date_rule: "매월 25일", base_period: "전월 1일–말일", variable_period: "전월 1일–말일", proration: "달력일 기준", channel: "은행 이체" })),
};
const payrollRuns: PayrollRun[] = runStatuses.map((status, n) => ({ id: id(850 + n), legal_entity_id: id(n === 12 ? 801 : 800), pay_group_id: id(n === 12 ? 812 : n % 2 ? 811 : 810), period_start: "2026-10-01", period_end: "2026-10-31", source_label: `모의 급여 ${n + 1}`, status, calculation_enabled: false, created_at: AT, updated_at: AT }));
export async function mockPayroll(page: Page, screen: { key: string; read: string }, state: PayrollState | string, held: Promise<void>) {
  if (!screen.key.startsWith("payroll")) return;
  const groups = { ...payGroups, items: state === "empty" ? [] : payGroups.items };
  await page.route(url => url.pathname === "/api/v1/onboarding/modules", route => route.fulfill({ json: [{ key: "payroll", ready: true, unblock: null }] }));
  await page.route(url => url.pathname.startsWith("/api/v1/payroll/"), async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname === screen.read) {
      if (state === "loading") await held;
      if (page.isClosed()) return;
      if (state === "failed" || state === "refused") return route.fulfill({ status: state === "failed" ? 500 : 403, json: failure(state === "failed" ? "internal_error" : "forbidden") });
    }
    if (url.pathname.endsWith("/pay-groups")) return route.fulfill({ json: groups });
    if (url.pathname.endsWith("/runs")) return route.fulfill({ json: { items: payrollRuns } });
    if (!url.pathname.endsWith("/reference/rates")) return route.fallback();
    const unsupported = state === "unsupported" || url.searchParams.get("legal_entity_id") === id(801);
    const json: PayrollRates = { country_code: unsupported ? "US" : "KR", adopted: !unsupported, items: state === "empty" ? [] : [{ ...rate, instrument_ko: state === "held" ? "" : rate.instrument_ko }] };
    return route.fulfill({ json });
  });
}
