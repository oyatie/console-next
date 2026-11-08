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
  expect(blockerText("CONTRACT_WAGE_NOT_IN_FORCE")).toBe("적용 중인 계약 임금이 없습니다");
  expect(blockerText("HOURLY_WAGE_NOT_SUPPORTED_IN_THIS_SLICE")).toBe("시급제 계약의 초안 계산을 지원하지 않습니다.");
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
test("the backend's incomparable sentence is localised without a comparator", async () => {
  const data = { ...draft, blockers: ["최저임금 비교 불가: 월 소정근로시간이 근로계약에 없다"], minimum_wage_check: undefined };
  expect(draftBlockers(data)).toEqual(["MINIMUM_WAGE_NOT_COMPARABLE"]);
  expect(blockerText(draftBlockers(data)[0]!)).toBe("최저임금을 비교할 수 없습니다.");
  await loadCatalog("en");
  i18n.set("en");
  try {
    expect(draftBlockers(data)).toEqual(["MINIMUM_WAGE_NOT_COMPARABLE"]);
    expect(blockerText(draftBlockers(data)[0]!)).toBe("Minimum wage cannot be compared.");
  } finally { i18n.set("ko"); }
});

test("minimum-wage findings preserve unknowns, deduplicate codes and distinguish no comparison from a pass", () => {
  for (const passes of [true, false, null] as const) {
    const code = passes === false ? "MINIMUM_WAGE_BELOW_FLOOR" : "MINIMUM_WAGE_NOT_COMPARABLE";
    expect(draftBlockers({ ...draft, blockers: [], minimum_wage_check: { ...draft.minimum_wage_check!, passes } })).toEqual(passes === true ? [] : [code]);
    expect(draftBlockers({ ...draft, blockers: [code, code, "UNKNOWN: details"], minimum_wage_check: { ...draft.minimum_wage_check!, passes } })).toEqual([code, "UNKNOWN: details"]);
  }
  expect(blockerText("MINIMUM_WAGE_NOT_COMPARABLE: detail")).toBe("최저임금을 비교할 수 없습니다.");
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

test("insurance totals reconcile every visible employee row and exclude employer costs", () => {
  const row = draft.deductions![0]!;
  const data: typeof draft = { ...draft, deductions: [row, { ...row, code: "HealthInsurance", employee_won: 123 }, { ...row, code: "IndustrialAccident", employer_only: true, employee_won: null }], total_employee_insurance_won: row.employee_won! + 123 };
  expect(insuranceCited(data)).toBe(true);
  expect(insuranceCited({ ...data, total_employee_insurance_won: row.employee_won! })).toBe(false);
  expect(insuranceCited({ ...data, total_employee_insurance_won: undefined })).toBe(false);
  expect(insuranceCited({ ...data, total_employee_insurance_won: null })).toBe(false);
  expect(insuranceCited({ ...data, total_employee_insurance_won: 1.5 })).toBe(false);
  expect(insuranceCited({ ...data, deductions: [{ ...row, employee_won: Number.MAX_SAFE_INTEGER }, { ...row, code: "HealthInsurance", employee_won: 1 }], total_employee_insurance_won: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  expect(insuranceCited({ ...data, deductions: [{ ...row, employee_won: 0 }], total_employee_insurance_won: 0 })).toBe(true);
  expect(insuranceCited({ ...data, deductions: [{ ...row, employer_only: true }], total_employee_insurance_won: 0 })).toBe(false);
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
