import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { loadCatalog } from "@console/i18n";
import type { ImportDryRun, ImportPreview, ImportRow, ReviewItem } from "../domain/contract";
import { initialPicks } from "../domain/steps";
import { PreviewStep } from "./preview-step";
import { ReviewResolve } from "./review-resolve";
import { RowDetail } from "./row-detail";

// The screens rendered from answers shaped as the server publishes them (generated schema), so a wording or a
// branch that the contract drives is checked without a server.

beforeAll(() => loadCatalog("ko"));
const html = (node: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const noop = () => undefined;

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
