// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import type { components } from "@console/api/schema";
import { fmtDate } from "@console/i18n/format";
import { SettlementFigures } from "./exit-facts";
import { SettlementForm } from "./exit-settlement";

// oxlint-disable-next-line react/forbid-elements -- Native links expose the router mock’s destination.
vi.mock("@tanstack/react-router", () => ({ Link: ({ to, params, search, children }: { to: string; params?: { id: string }; search?: { act?: string }; children: ReactNode }) => <a href={`${to.replace("$id", params?.id ?? "")}${search?.act ? `?act=${search.act}` : ""}`}>{children}</a> }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ isPending: false, error: null }) }));
vi.mock("./use-exit-command", () => ({
  EXIT_INVALIDATES: [], focusFirstInvalid: vi.fn(),
  useExitCommand: () => ({ phase: { kind: "idle" }, locked: false, error: null }),
}));

type Package = components["schemas"]["EmployeeExitSettlementPackage"];
type Case = components["schemas"]["EmployeeExitCase"];
function pkg(reason = "UNDER_SERVICE_YEARS", num = 1, den = 1): Package {
  return {
    id: "package", status: "READY_FOR_APPROVAL", insurance_loss_payload: {}, approval_payload: {},
    generated_at: "2026-10-21T00:00:00Z", certification_status: "UNCERTIFIED_DRAFT",
    missing_source_fields: [], service_days: 1,
    statutory_basis: {
      severance_eligibility: { outcome: "NOT_ELIGIBLE", reason, threshold: { num, den } },
      calculation_references: { rules: [{ code: "SEVERANCE_MIN_SERVICE_YEARS", effective_from: "2026-07-01", citation: { instrument_ko: "검증 법령", article_ko: "검증 조항" } }] },
    },
  };
}
const form = (p: Package, state: Case["exit_event_state"] = "APPLIED") => renderToStaticMarkup(<SettlementForm c={{
  id: "case", employee_id: "person", employee_name: "합성 직원", effective_exit_date: "2026-10-21",
  exit_event_state: state, settlement_package: p,
} as Case} onDone={() => {}} />);
beforeEach(async () => { i18n.set("ko"); await loadCatalog("ko"); });

test.each([
  ["UNDER_SERVICE_YEARS", 2, 1, "근속 2년 미만"],
  ["UNDER_WEEKLY_HOURS", 29, 2, "주 29/2시간 미만"],
])("%s displays the server threshold and dated citation without wage inputs", (reason, num, den, label) => {
  const html = form(pkg(reason, num, den));
  expect(html).toContain(`퇴직금 미해당 (${label})`);
  expect(html).toContain("노무사 검토 전");
  expect(html).toContain("검증 법령");
  expect(html).toContain("검증 조항");
  expect(html).toContain(fmtDate("2026-07-01"));
  expect(html).not.toContain('type="text"');
  expect(html).not.toContain('aria-disabled="true"');
});

test.each(["OPEN", "FUTURE_OUTCOME"])("%s cannot bypass wage evidence using a stale amount", (outcome) => {
  const p = pkg();
  p.statutory_basis = { severance_eligibility: { outcome } };
  p.severance_pay_won = 3_000_000;
  expect(form(p)).toContain('aria-disabled="true"');
  expect(renderToStaticMarkup(<SettlementFigures pkg={p} />)).not.toContain("3,000,000");
});

test.each([
  ["UNDER_SERVICE_YEARS", 1, "근속 1년 미만"],
  ["UNDER_WEEKLY_HOURS", 15, "주 15시간 미만"],
])("certified %s does not display a pending legal review", (reason, threshold, label) => {
  const p = pkg(reason, threshold);
  p.certification_status = "CERTIFIED";
  const html = renderToStaticMarkup(<SettlementFigures pkg={p} />);
  expect(html).toContain(`퇴직금 미해당 (${label})`);
  expect(html).not.toContain("노무사 검토 전");
  expect(html).not.toContain("검증 전 초안");
});

test("English renders the recorded reason and counsel review hold", async () => {
  await loadCatalog("en"); i18n.set("en");
  const html = form(pkg("UNDER_WEEKLY_HOURS", 15));
  expect(html).toContain("Severance not applicable (below 15 hours per week)");
  expect(html).toContain("Pending labor counsel review");
});

test.each(["SCHEDULED", "APPLY_FAILED"] as const)("a not applicable decision does not bypass %s", (state) => {
  const html = form(pkg(), state);
  expect(html).toContain("퇴직금 미해당");
  expect(html).toContain('aria-disabled="true"');
});

test("missing sources still block a recorded not applicable decision", () => {
  const p = pkg(); p.missing_source_fields = ["statutory_rules"];
  const html = form(p);
  expect(html).toContain("퇴직금 미해당");
  expect(html).toContain('aria-disabled="true"');
});

test.each([null, "invalid-citation", { code: "invalid-citation", effective_from: "invalid-date", citation: { instrument_ko: "invalid-citation", article_ko: "article" } }])("malformed dated references are not rendered: %j", rule => {
  const p = pkg();
  p.statutory_basis = { ...p.statutory_basis, calculation_references: { rules: [rule] } };
  const html = renderToStaticMarkup(<SettlementFigures pkg={p} />);
  expect(html).not.toContain("invalid-citation");
  expect(html).not.toContain("calculation_references");
});

test("legacy figures and eligible wage inputs retain their existing behavior", () => {
  const p = pkg(); p.statutory_basis = {}; p.severance_pay_won = 3_000_000;
  expect(form(p)).toContain('type="text"');
  expect(form(p)).not.toContain('aria-disabled="true"');
  expect(renderToStaticMarkup(<SettlementFigures pkg={p} />)).toContain("3,000,000");
  p.statutory_basis = { severance_eligibility: { outcome: "ELIGIBLE" } };
  expect(form(p)).toContain('type="text"');
});


test("missing employment and rule sources name the repair routes even after wages are saved", () => {
  const p = pkg();
  p.status = "NEEDS_SOURCE"; p.statutory_basis = {};
  p.missing_source_fields = ["hire_date", "statutory_rules"];
  Object.assign(p, { average_wage_period_start: "2026-07-21", average_wage_period_end: "2026-10-20", average_wage_calendar_days: 92, average_wage_total_won: 9_000_000, monthly_ordinary_wage_won: 3_000_000 });
  const html = form(p);
  expect(html).toContain("입사일 확인·정정");
  expect(html).toContain('/people/person?act=fix:hire_date');
  expect(html).toContain("법정 기준 누락 · 관리자에게 퇴직일 기준 법정 기준 대장 검토를 요청하십시오");
  expect(html).not.toContain('/payroll/reference');
  expect(html).toContain('aria-disabled="true"');
});

test("each missing wage source is named with the instruction to enter it and recalculate", () => {
  const p = pkg(); p.statutory_basis = {};
  p.missing_source_fields = ["average_wage_period_start", "average_wage_period_end", "average_wage_calendar_days", "average_wage_total_won", "monthly_ordinary_wage_won"];
  const html = form(p);
  expect(html).toContain("계산에 필요한 자료");
  for (const label of ["평균임금 산정 시작일", "평균임금 산정 종료일", "산정 기간 총일수", "기간 임금 총액", "월 통상임금"]) {
    expect(html).toContain(`<li>${label}`);
  }
  expect(html).toContain("입력 후 다시 계산");
});

test("backend source metadata is omitted and exemption daily wages stay hidden", () => {
  const p = pkg();
  p.severance_pay_won = 0; p.average_daily_wage_milliwon = 100_000_000; p.ordinary_daily_wage_won = 110_000;
  p.statutory_basis = { ...p.statutory_basis, retirement_pay: { authority: "source-authority", formula: "average_daily_wage * 30 * service_days / 365" }, insurance_loss: { title: "source-title" } };
  const html = renderToStaticMarkup(<SettlementFigures pkg={p} />);
  expect(html).not.toContain("retirement_pay");
  expect(html).not.toContain("insurance_loss");
  expect(html).not.toContain("average_daily_wage *");
  expect(html).not.toContain("평균임금 (1일)");
  expect(html).not.toContain("통상임금 (1일)");
  expect(html).not.toContain("0원");
});

test("malformed exemption cannot display a stale zero or daily wage amounts", () => {
  const p = pkg("UNKNOWN"); p.severance_pay_won = 0;
  p.average_daily_wage_milliwon = 100_000_000; p.ordinary_daily_wage_won = 110_000;
  p.statutory_basis = { ...p.statutory_basis, retirement_pay: { formula: "inapplicable-formula" } };
  const html = renderToStaticMarkup(<SettlementFigures pkg={p} />);
  expect(html).not.toContain("0원");
  expect(html).not.toContain("100,000"); expect(html).not.toContain("110,000");
  expect(html).not.toContain("inapplicable-formula");
  expect(form(p)).toContain('aria-disabled="true"');
});

test("each citation group has its own accessible name and eligible daily wages remain visible", () => {
  const p = pkg();
  p.statutory_basis = { severance_eligibility: { outcome: "ELIGIBLE" }, calculation_references: { rules: [
    { code: "first-rule", effective_from: "2026-07-01", citation: { instrument_ko: "첫 법령", article_ko: "제1조" } },
    { code: "second-rule", effective_from: "2026-07-01", citation: { instrument_ko: "둘째 법령", article_ko: "제2조" } },
  ] } };
  p.average_daily_wage_milliwon = 100_000_000; p.ordinary_daily_wage_won = 110_000;
  const html = renderToStaticMarkup(<SettlementFigures pkg={p} />);
  expect(html).toContain('>첫 법령 · 제1조</span>');
  expect(html).toContain('>둘째 법령 · 제2조</span>');
  expect(html).toContain("평균임금 (1일)"); expect(html).toContain("100,000원");
  expect(html).toContain("통상임금 (1일)"); expect(html).toContain("110,000원");
});
