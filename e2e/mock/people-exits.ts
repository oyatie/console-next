// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { AT, authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import type { ExitCaseState } from "../states/people-exits";

type S = components["schemas"];
const exitItem = (overrides: Partial<S["LifecycleCaseItem"]> = {}): S["LifecycleCaseItem"] => ({
  id: id(7100), case_id: id(7000), item_key: "X6", kind: "PAY", label: "금품청산", label_key: null,
  owner_line: "hr_basic.edit", status: "OPEN", status_code: null, opens_on: "2026-10-27", opens_in_days: 0,
  due_date: "2026-11-09", due_in_days: 3, due_disposition: "KNOWN", due_rule_ref: "register-rule",
  opens_rule_ref: null, basis: { instrument: "검증 법령", article: "검증 조항" }, blocks_close: true,
  observed_ref: null, exception_id: null, filing_obligation_id: null, version: 1,
  completion_rule_ref: "LIFECYCLE_ITEM_ATTESTED", completion_risk: "LOW", ...overrides,
});
export const exitTrail = (): S["LifecycleCase"] => ({
  id: id(7000), employee_id: id(7001), kind: "EXIT", state: "OPEN", trigger_id: null,
  effective_date: "2026-10-26", linked_case_id: null, cancellation_reason: null, version: 1,
  items: [
    exitItem(),
    exitItem({ id: id(7101), item_key: "X1", kind: "REC", label: "퇴직일 확정", basis: { exit_leg: "approval" }, due_date: null, due_in_days: null, due_rule_ref: null }),
    exitItem({ id: id(7102), item_key: "X18", kind: "BACK", label: "업무 인수인계", basis: { exit_leg: "handover" } }),
    exitItem({ id: id(7103), item_key: "X19", kind: "BACK", label: "회사 자산·자료 반납" }),
    exitItem({ id: id(7104), item_key: "X9", kind: "FIL", label: "국민연금 상실 신고", filing_obligation_id: id(7200), filing_kind: "LOSE", insurer: "NPS" }),
    exitItem({ id: id(7105), item_key: "future-kind", kind: "FUTURE", label: "추가 서류", due_disposition: "UNKNOWN", due_date: "2099-01-01", due_in_days: 9000 }),
    ...["X8", "X14", "X15"].map((item_key, i) => exitItem({ id: id(7110 + i), item_key, kind: "DOC", label: ["최종 임금명세서", "중도퇴사 연말정산", "퇴직소득 원천징수영수증"][i]!, due_in_days: -9, basis: { exit_leg: "settlement", payroll_pending: true } })),
  ],
});
const exitCase = (state: ExitCaseState): S["EmployeeExitCase"] => ({
  id: id(7000), employee_id: id(7001), employee_name: "김퇴직", employee_number: "EXIT-001", company: "화면 검증 회사",
  status: state === "reported" ? "REPORTED" : "HR_CONFIRMED", effective_exit_date: "2026-10-26",
  site_manager_note: "개인 사정", involuntary: state === "dismissal", notice_required: state === "dismissal",
  dismissal_notice: null, protected_periods: [], reported_by: id(1), reported_by_name: "김보고", reported_at: AT,
  hr_confirmed_by_name: null, hq_confirmed_by_name: null, approval_submitted_by_name: null, closed_by_name: null,
  ...(state === "settlement-unavailable" ? { settlement_package: { id: id(7300), status: "NEEDS_SOURCE", missing_source_fields: ["monthly_ordinary_wage_won"], statutory_basis: {}, insurance_loss_payload: {}, approval_payload: {}, certification_status: "UNCERTIFIED_DRAFT", generated_at: AT } } : {}),
  exit_lifecycle_event_id: null, exit_event_state: state === "hr-confirmed" ? "SCHEDULED" : null,
  next_actions: state === "closed" ? [] : [{ key: state === "reported" ? "confirm_exit" : "confirm_exit_hq" }],
});

export async function mockExitCase(page: Page, state: ExitCaseState) {
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [] } });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases/{id}", state === "missing"
    ? { status: 404, json: failure("not_found") } : state === "failed"
      ? { status: 503, json: failure("service_unavailable") } : { status: 200, json: exitCase(state) });
  const trail = exitTrail();
  if (state === "closed") trail.state = "CLOSED";
  if (state === "dismissal") trail.items.push(exitItem({ id: id(7120), item_key: "DM2", kind: "NOT", label: "해고예고", due_in_days: -2 }));
  // NEEDS-BACKEND: register-owned basis.exit_leg and basis.payroll_pending.
  await page.route(url => url.pathname === `/api/v1/lifecycle-cases/${trail.id}`, route => route.fulfill({ status: 200, json: trail }));
}
