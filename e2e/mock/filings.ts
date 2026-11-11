// SPDX-License-Identifier: LicenseRef-Proprietary
import type { FilingTask } from "@console/api/pending";
import type { Page } from "@playwright/test";
import { id } from "./fixtures";
import { mockRoute } from "./route";

export const filingTask: FilingTask = {
  event_id: id(8100), filing_obligation_id: id(8101), employee_id: id(100), name: "김신고", employee_number: "HR-001",
  kind: "ACQUIRE", insurer: "NPS", effective_date: "2026-09-01", legal_entity_id: id(3),
  workplace_id: id(4), workplace_name: "본사", due_date: "2026-09-15", due_in_days: 3, deadline_status: "HOLD",
  version: 1, completed_on: null, receipt_number: null, loss_code: null, detail: null,
  opens_on: "2026-09-01", target_on: "2026-09-01", due_on: "2026-09-15", dates: null,
  basis: { code: "pension-acquire", citation: { instrument: "국민연금법", article: "제21조", promulgation: "법률",
    source_url: "https://www.law.go.kr/법령/국민연금법", enforced_on: "2026-01-01" },
    applicability_citations: [], remuneration_required: false, exclusions: [], covered_by: null, penalty: null },
  applicability: { status: "APPLIES" }, applicability_facts: {}, can_record_sensitive_facts: false, birth_date_known: false,
  state: "PENDING", record_action: null, not_applicable_reason: null, not_applicable_options: [],
  total_remuneration_won: null, is_request: false, acquired_on: null, loss_options: [],
};

export async function mockFilings(page: Page, task: FilingTask = filingTask) {
  const queries: URLSearchParams[] = [];
  await mockRoute(page, "get", "/api/v1/statutory/workplaces", { status: 200, json: [{ id: id(4), name: "본사", entity_name: "예시회사" }] });
  await mockRoute(page, "get", "/api/v1/statutory/insurance-filings", request => {
    const query = new URL(request.url()).searchParams;
    queries.push(query);
    const items = query.get("search") ? [] : query.get("state") === "DONE" ? [{ ...task, completed_on: "2026-09-02", receipt_number: "RECEIPT-001", record_action: "COMPLETE" }] : [task];
    return { status: 200, json: { items, total: items.length, pending: items.length, next: null } };
  });
  return queries;
}
