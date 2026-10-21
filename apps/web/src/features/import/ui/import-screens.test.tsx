import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { components } from "@console/api/schema";
import { ApiError } from "../api";
import { loadCatalog, t } from "@console/i18n";
import type { ImportDryRun, ImportPreview, ImportRow, ReviewItem } from "../domain/contract";
import { initialPicks } from "../domain/steps";
import { PreviewStep } from "./preview-step";
import { ReviewResolve } from "./review-resolve";
import { RowDetail } from "./row-detail";
import { ValueTable } from "./value-table";
import { DoneStep } from "./done-step";
import { RecentRuns } from "./recent-runs";
import { RollbackPanel } from "./rollback-panel";
import { applyJobQuery, runQuery, runsQuery, type ImportRun, type RollbackPreview } from "../api";

const rollbackState = vi.hoisted(() => ({ acknowledged: false }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => rollbackState.acknowledged && Array.isArray(initial) && initial.length === 0 ? [["acknowledged"], vi.fn()] : react.useState(initial) };
});
afterEach(() => { rollbackState.acknowledged = false; });

// The screens rendered from answers shaped as the server publishes them (generated schema), so a wording or a
// branch that the contract drives is checked without a server.

beforeAll(() => loadCatalog("ko"));
const html = (node: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const noop = () => undefined;

test.each(["review", "value links"] as const)("future leave choices render in %s", (place) => {
  const item = { id: "future", reason: "remembered", decision: "leave_type_map", value: "Synthetic leave", rows: 1, blocking: false, resolution: { decision: "leave_type_map", key: "Synthetic leave", choices: ["FUTURE_LEAVE"] } } as unknown as ReviewItem;
  const dry = { rows: [], review: { items: [item] }, remembered: [], decisions: { leave_type_map: { "Synthetic leave": "FUTURE_LEAVE" } } } as unknown as ImportDryRun;
  const props = { dry, picks: initialPicks(), busy: false, onResolve: noop, onSheets: noop };
  const rendered = html(place === "review" ? <ReviewResolve item={item} {...props} /> : <ValueTable sel={null} onSel={noop} {...props} />);
  expect(rendered).toContain("확인되지 않은 항목");
  expect(rendered).toContain('<span class="chip chip--neutral">FUTURE_LEAVE</span>');
});

test("imported future leave types keep a neutral label and a muted code", () => {
  const r = { sheet: "Synthetic sheet", row: 1, name: "Synthetic employee", outcome: "insert", new_person: { leave: { start_date: "2026-10-01", leave_type: "FUTURE_LEAVE" } } } as ImportRow;
  const rendered = html(<RowDetail r={r} />);
  expect(rendered).toContain("확인되지 않은 항목");
  expect(rendered).toContain('<span class="chip chip--neutral">FUTURE_LEAVE</span>');
  expect(rendered.split("FUTURE_LEAVE")).toHaveLength(2);
});

const preview: ImportPreview = {
  run_id: "r1",
  entity_type: "employee_hr",
  source_filename: "roster.xlsx",
  source_sha256: "a".repeat(64),
  input_rows: 3,
  candidate_rows: 3,
  preserved_rows: 0,
  columns: [
    { source_header: "name", normalized_header: "name", target: "name", classification: "canonical", preview_allowed: true },
    { source_header: "rrn", normalized_header: "rrn", classification: "restricted", preview_allowed: false },
    { source_header: "사업장", normalized_header: "사업장", target: "worksite_name", classification: "canonical", preview_allowed: true, notice: "customer_site_not_workplace" } as ImportPreview["columns"][number],
  ],
  sample_rows: [],
  mapping_profile: {},
  sheets: [
    { name: "본사", status: "mapped", rows: 3, header_row: 2, columns: [{ column: "B", label: "성명", target: "name", source: "remembered" }] },
    { name: "메모", status: "needs_mapping", rows: 5, header_candidates: [{ row: 2, cells: [{ column: "A", label: "이름" }] }] },
  ],
  sheets_needing_mapping: 1,
  available_targets: ["name", "employee_number", "employment_status"],
  sealed_identities: 3,
};
const renderPreview = (p: ImportPreview) => (
  <PreviewStep preview={p} picks={initialPicks()} mapping={{}} rereading={false} onRemap={noop} onDryRun={noop} onExpired={noop} onRestart={noop} />
);

test("preview: restricted columns read as not stored; a 사업장 column is read as the customer site; a sheet without a header opens for mapping and keeps the dry run closed", () => {
  const out = html(renderPreview(preview));
  expect(out).toContain("저장하지 않음");
  expect(out).toContain("고객 현장으로 읽음");
  expect(out).not.toContain("사업장 열은 고객 현장(근무지)으로 읽었습니다");
  expect(out).toContain("기억해 둔 머리글");
  expect(out).toContain("연결 필요");
  expect(out).toContain("메모 시트의 머리글 행");
  expect(out).toContain("재직 상태");
  expect(out).toContain("열을 연결하지 않은 시트가 1개 있습니다");
  expect(html(renderPreview({ ...preview, sheets: preview.sheets.slice(0, 1), sheets_needing_mapping: 0 }))).not.toContain("열을 연결하지 않은 시트");
});

const row = (over: Partial<ImportRow>): ImportRow => ({ source_key: `k${over.row ?? 2}`, sheet: "SheetA", row: 2, name: "Kim", outcome: "update", ...over });

test("unknown import targets, fields and routes render as plain labels", () => {
  expect(html(renderPreview({ ...preview, columns: [{ ...preview.columns[0]!, target: "future_target" }] })))
    .toContain("<b>future_target</b>");
  expect(html(<RowDetail r={row({ deferred: [{ field: "future_field", from: "Before", to: "After", route: "future_route" }] })} />))
    .toContain("future_field: Before → After · future_route");
  expect(html(<RowDetail r={row({ outcome: "refused", refusal_code: "invalid_date", refusal_field: "future_refusal_field" })} />))
    .toContain("future_refusal_field:");
});

test("row detail: a deferred change names its flow, a refusal its field and why, a 휴직 new person its leave, 사번 미부여 says so", () => {
  expect(html(<RowDetail r={row({ diff: [{ field: "position", from: "Staff", to: "Lead" }], deferred: [{ field: "org_unit", from: "HR", to: "Sales", route: "lifecycle_transfer" }] })} />))
    .toContain("부서: HR → Sales · 발령으로 처리합니다");
  expect(html(<RowDetail r={row({ outcome: "refused", refusal_code: "leave_return_required", refusal_field: "leave_return_date" })} />)).toContain("복직 예정일: 육아휴직");
  const leave = html(<RowDetail r={row({ outcome: "insert", new_person: { status: "ON_LEAVE", hire_date: "2020-01-01", migrated_former: false, employee_number: null, leave: { start_date: "2026-03-01", leave_type: "CHILDCARE", expected_return_date: "2027-02-28" } } })} />);
  expect(leave).toContain("육아휴직 휴직으로 들어옵니다: 2026-03-01부터, 복직 예정 2027-02-28");
  expect(leave).toContain("사번 없이 등록합니다");
});

const dry = (rows: ImportRow[]) => ({ rows, decisions: {} }) as unknown as ImportDryRun;
const resolve = (item: ReviewItem, rows: ImportRow[] = []) =>
  html(<ReviewResolve item={item} dry={dry(rows)} picks={initialPicks()} busy={false} onResolve={noop} onSheets={noop} />);

test("resolve: namesakes are told apart by 사번, 법인·부서 and a masked 생년월일, never a name suffix; a new person is one click", () => {
  const r = row({
    row: 4, name: "김민준", outcome: "unresolved_identity",
    candidates: [
      { employee_id: "p1", employee_number: "GR-0001", status: "ACTIVE", basis: "name_birth_date", company: "가람", org_unit: "인사팀", birth_date_masked: "1990-01-**" },
      { employee_id: "p2", employee_number: null, status: "ON_LEAVE", basis: "name_only", company: "누리", org_unit: "생산팀" },
    ],
  });
  const out = resolve({ id: "x", reason: "unresolved_identity", blocking: true, sheet: "SheetA", row: 4, cell: "B4", rows: 1, resolution: { decision: "identity", key: "k4", choices: ["p1", "p2", "new"] } }, [r]);
  expect(out).toContain("GR-0001");
  expect(out).toContain("가람 · 인사팀");
  expect(out).toContain("생년월일 1990-01-**");
  expect(out).toContain("사번 미부여");
  expect(out).toContain("휴직");
  expect(out).toContain("새 직원으로 등록");
  expect(out).toContain("SheetA 시트 B4");
  expect(out).not.toContain("김민준(2)");
});

test("resolve: a status text offers the served codes in words; 사번 미부여 asks for the number; a deferred change says where it goes", () => {
  expect(resolve({ id: "s", reason: "status_unmapped", blocking: true, sheet: "A", rows: 7, value: "휴직중", resolution: { decision: "status_map", key: "휴직중", choices: ["ACTIVE", "ON_LEAVE"] } }))
    .toMatch(/재직[\s\S]*휴직[\s\S]*7행에 적용/);
  expect(resolve({ id: "n", reason: "employee_number_missing", blocking: false, sheet: "A", rows: 1, resolution: { decision: "employee_numbers", key: "k2", choices: [] } }, [row({})]))
    .toContain("Kim님에게 줄 사번");
  const deferred = row({ deferred: [{ field: "org_unit", route: "lifecycle_transfer" }] });
  expect(resolve({ id: "d", reason: "deferred_change", blocking: false, sheet: "SheetA", row: 2, rows: 1, field: "org_unit" }, [deferred])).toContain("가져오기로 변경하지 않습니다. 발령으로 처리합니다.");
});

const recordedRun: components["schemas"]["EmployeeImportRun"] = {
  id: "00000000-0000-0000-0000-000000000001", source_filename: "stored-roster.xlsx", status: "APPLIED",
  created_at: "2026-10-01T01:00:00Z", applied_at: "2026-10-01T02:00:00Z", applied_by: { id: "actor", name: "담당테스트" },
  apply_summary: { input_rows: 12, inserted: 10, updated: 1, skipped: 1, companies: [] },
  rolled_back_at: null, rolled_back_by: null, rollback_reason_code: null, rollback_note: null,
  apply_job_state: null,
  rollback: { mode: "SETUP", window_until: null, window_days: 14, pending_request: null, refusal_code: null }, allowed: ["preview_rollback"],
};

function recordedScreen(node: ReactNode, items = [recordedRun], jobState: "settling" | "failed" | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQuery(recordedRun.id).queryKey, { ...recordedRun, apply_job_state: jobState });
  client.setQueryData(runsQuery.queryKey, { items, next_cursor: null });
  if (jobState) client.setQueryData(applyJobQuery(recordedRun.id).queryKey, { run_id: recordedRun.id, state: jobState, total: 12, done: 6 });
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(<RouterContextProvider router={router}><QueryClientProvider client={client}>{node}</QueryClientProvider></RouterContextProvider>);
}

test("result opened by run id shows the stored file, actor, zoned time and immutable counts", () => {
  const out = recordedScreen(<DoneStep runId={recordedRun.id} />);
  expect(out).toContain("stored-roster.xlsx");
  expect(out).toContain("담당테스트");
  expect(out).toContain('dateTime="2026-10-01T02:00:00Z"');
  expect(out).toMatch(/GMT\+9|KST|한국 표준시/);
  expect(out).toContain("신규 10명");
  expect(out).toContain("갱신 1명");
});

test("recent import rows link to the served result record with counts from its stored summary", () => {
  const out = recordedScreen(<RecentRuns />);
  expect(out).toContain(`href="/people/import?run=${recordedRun.id}"`);
  expect(out).toContain("등록 10 · 갱신 1");
  expect(out).toContain("반영됨");
});

test("an empty recent-run list promises no fixed rollback window or second-person policy", () => {
  const out = recordedScreen(<RecentRuns />, []);
  expect(out).not.toContain("7일");
  expect(out).not.toContain("다른 사람의 승인");
});

test("APPLIED while settlement is unfinished or failed stays on the existing job screen", () => {
  for (const state of ["settling", "failed"] as const) {
    const out = recordedScreen(<DoneStep runId={recordedRun.id} />, [], state);
    expect(out).not.toContain("명부를 반영했습니다");
    expect(out).toContain(state === "settling" ? "배치와 고용 정보를 기록하는 중입니다" : "반영하지 못했습니다");
  }
});

const rollbackPlan: RollbackPreview = {
  run_id: recordedRun.id, mode: "SETUP", basis: "DIRECT", window_until: null, window_days: 14,
  preview_digest: "a".repeat(64), allowed: ["rollback"], blockers: [],
  rows: [
    { employee_id: "person-new", employee_number: "E-0002", inserted: true, fields: [], effects: ["profile_created", "rrn_recorded"] },
    { employee_id: "person-existing", employee_number: "E-0001", inserted: false, fields: [{ field: "job", current: "After", before: "Before" }], effects: [] },
  ],
};

function rollbackScreen(run: ImportRun = recordedRun, plan = rollbackPlan, error?: ApiError) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  const queryKey = ["/api/v1/employee-import-runs/{run_id}/rollback/preview", { path: { run_id: run.id } }];
  client.setQueryData(queryKey, plan);
  if (error) client.getQueryCache().find({ queryKey })!.setState({ data: undefined, error, status: "error" });
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(<RouterContextProvider router={router}><QueryClientProvider client={client}><RollbackPanel run={run} onChanged={noop} /></QueryClientProvider></RouterContextProvider>);
}

test("rollback preview lists the inverse and keeps execution disabled until acknowledged", () => {
  const out = rollbackScreen();
  expect(out).toContain("After → Before");
  expect(out).toContain(t("import.rollback.void"));
  expect(out).toContain('href="/people/person-existing"');
  expect(out).toContain(t("import.rollback.acknowledged"));
  expect(out).toContain('type="checkbox"');
  expect(out).toMatch(/<button[^>]*(?:disabled|aria-disabled="true")[^>]*>[\s\S]*?되돌리기/);
  expect(out).not.toContain(t("import.rollback.reason"));
});

test("acknowledging the current rollback preview arms the setup command", () => {
  rollbackState.acknowledged = true;
  const out = rollbackScreen();
  expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
  expect(out).toContain(`<button type="button" class="btn btn--primary">${t("import.rollback.execute")}</button>`);
});

test("pending rollback shows its filing time and offers no requester decision controls", () => {
  const out = rollbackScreen({ ...recordedRun, status: "ROLLBACK_REQUESTED", allowed: [], rollback: { ...recordedRun.rollback, pending_request: { id: "request-1", requested_by: "actor", created_at: "2026-10-01T03:00:00Z" } } });
  expect(out).toContain(t("import.rollback.wait"));
  expect(out).toMatch(/GMT\+9|KST|한국 표준시/);
  expect(out).not.toContain("<button");
  expect(out).not.toContain(t("import.rollback.acknowledge"));
});

test("rolled-back run shows the completing actor and zoned time", () => {
  const out = rollbackScreen({ ...recordedRun, status: "ROLLED_BACK", allowed: [], rolled_back_at: "2026-10-01T04:00:00Z", rolled_back_by: { id: "decider", name: "결정테스트" } });
  expect(out).toContain(t("import.rollback.done"));
  expect(out).toContain("결정테스트");
  expect(out).not.toContain("<button");
});

test.each(["work_record", "changed_since", "later_run", "account_linked"] as const)("a %s blocker disables the whole rollback and links to its employee", (kind) => {
  rollbackState.acknowledged = true;
  const out = rollbackScreen(recordedRun, { ...rollbackPlan, allowed: [], blockers: [{ employee_id: "blocked-person", employee_number: "E-0042", kind, field: null, record: "/people/blocked-person", since: "2026-10-01T03:00:00Z" }] });
  expect(out).toContain(t("import.rollback.blocked"));
  expect(out).toContain('href="/people/blocked-person"');
  expect(out).toContain("E-0042");
  expect(out).toMatch(/<button[^>]*(?:disabled|aria-disabled="true")/);
  expect(out).not.toContain('type="checkbox"');
});

test("a closed rollback window shows the server's date and a per-record correction route", () => {
  const out = rollbackScreen({ ...recordedRun, allowed: [], rollback: { ...recordedRun.rollback, mode: "GOVERNED", refusal_code: "import_rollback_window_closed", window_until: "2026-10-15T02:00:00Z", window_days: 14 } });
  expect(out).toContain(t("import.rollback.closed"));
  expect(out).toMatch(/GMT\+9|KST|한국 표준시/);
  expect(out).toContain('href="/people"');
  expect(out).not.toContain("7일");
  expect(out).not.toContain("<button");
});

test("a forbidden rollback preview uses the shared denied state and offers no execution", () => {
  const out = rollbackScreen(recordedRun, rollbackPlan, new ApiError(403, "scope_tenant_wide_only", "denied"));
  expect(out).toContain(t("common.denied.title.plain"));
  expect(out).not.toMatch(/<button[^>]*>되돌리기<\/button>/);
});

 test("rollback names the home branch being cleared instead of exposing its field code", () => {
  const out = rollbackScreen(recordedRun, { ...rollbackPlan, rows: [{ employee_id: "matched", employee_number: "HB-01", inserted: false, fields: [{ field: "home_branch_id", current: "본점", before: null }], effects: ["home_branch_set"] }] });
  expect(out).toContain("지점: 본점 → 미지정");
  expect(out).not.toContain("home_branch");
});
