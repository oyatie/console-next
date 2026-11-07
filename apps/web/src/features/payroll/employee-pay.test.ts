// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, i18n } from "@console/i18n";
import { deductionCited, contractCited, blockerText, draftBlockers, insuranceCited } from "./present";
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

test("minimum-wage blockers use typed codes, never the backend sentence", () => {
  for (const [passes, code] of [[false, "MINIMUM_WAGE_BELOW_FLOOR"], [null, "MINIMUM_WAGE_NOT_COMPARABLE"]] as const) {
    expect(draftBlockers({ ...draft, blockers: ["ATTENDANCE_INCOMPLETE: details", "최저임금 미달: raw backend sentence"], minimum_wage_check: { ...draft.minimum_wage_check!, passes } })).toContain(code);
  }
  expect(draftBlockers({ ...draft, blockers: ["최저임금 미달: raw sentence"], minimum_wage_check: { ...draft.minimum_wage_check!, passes: false } })).toEqual(["MINIMUM_WAGE_BELOW_FLOOR"]);
  expect(draftBlockers(draft)).toEqual(draft.blockers);
  expect(draftBlockers({ ...draft, blockers: ["UNKNOWN: details"], minimum_wage_check: undefined })).toEqual(["UNKNOWN: details"]);
  expect(draftBlockers({ ...draft, blockers: [], minimum_wage_check: { ...draft.minimum_wage_check!, passes: false } })).toEqual(["MINIMUM_WAGE_BELOW_FLOOR"]);
  expect(blockerText("MINIMUM_WAGE_BELOW_FLOOR")).toBe("최저임금에 미달합니다.");
});
test("insurance totals require every employee component's citation", () => {
  expect(insuranceCited(draft)).toBe(true);
  expect(insuranceCited({ ...draft, deductions: [] })).toBe(false);
  expect(insuranceCited({ ...draft, deductions: undefined })).toBe(false);
  for (const change of [{ blocked_by: "unresolved" }, { employee_won: null }, { instrument: { ...draft.deductions![0]!.instrument, url: "" } }, { share_instrument: { ...draft.deductions![0]!.instrument, url: "" } }]) {
    expect(insuranceCited({ ...draft, deductions: [{ ...draft.deductions![0]!, ...change }] })).toBe(false);
  }
  expect(insuranceCited({ ...draft, deductions: [...draft.deductions!, { ...draft.deductions![0]!, employer_only: true, employee_won: null }] })).toBe(true);
});

test("legacy minimum-wage findings retain typed codes in English", async () => {
  await loadCatalog("en");
  i18n.set("en");
  try {
    const [code] = draftBlockers({ ...draft, blockers: ["최저임금 미달: raw sentence"], minimum_wage_check: undefined });
    expect(code).toBe("MINIMUM_WAGE_BELOW_FLOOR");
    expect(blockerText(code!)).toBe("Below the minimum wage.");
  } finally { i18n.set("ko"); }
});
