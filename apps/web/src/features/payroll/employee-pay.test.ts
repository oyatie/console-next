// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { deductionCited, contractCited, blockerText } from "./present";
import { draft } from "../../../../../e2e/mock/employee-pay";
beforeAll(() => loadCatalog("ko"), 60_000);
test("contract amounts require their effective-dated source", () => {
  expect(contractCited(draft.contract)).toBe(true);
  expect(contractCited(null)).toBe(false);
  expect(contractCited({ ...draft.contract!, source_note: " " })).toBe(false);
  expect(contractCited({ ...draft.contract!, amount_won: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
});
test("deductions require both instruments, provenance and a settled amount", () => {
  const row = draft.deductions![0]!;
  expect(deductionCited(row)).toBe(true);
  for (const field of ["name_ko", "article_ko", "promulgation_ko", "enforced_on", "url", "retrieved_on"] as const)
    expect(deductionCited({ ...row, instrument: { ...row.instrument, [field]: "" } })).toBe(false);
  expect(deductionCited({ ...row, instrument: { ...row.instrument, url: "http://example.com" } })).toBe(false);
  expect(deductionCited({ ...row, share_instrument: { ...row.instrument, url: "javascript:alert(1)" } })).toBe(false);
  expect(deductionCited({ ...row, provenance_ko: " " })).toBe(false);
  expect(deductionCited({ ...row, blocked_by: "unresolved" })).toBe(false);
  expect(deductionCited({ ...row, employee_won: null })).toBe(false);
  expect(deductionCited({ ...row, employee_won: 1.5 })).toBe(false);
  expect(deductionCited({ ...row, employee_won: 0 })).toBe(true);
});

test("known blockers are localised without hiding an unknown blocker", () => {
  expect(blockerText("ATTENDANCE_INCOMPLETE: backend details")).toBe("근태 기록이 충분하지 않습니다.");
  expect(blockerText("WITHHOLDING_NOT_COMPUTED")).toBe("원천징수를 계산하지 않았습니다.");
  expect(blockerText("UNKNOWN")).toBe("확인 필요 · UNKNOWN");
});
