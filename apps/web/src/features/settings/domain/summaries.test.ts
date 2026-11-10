// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { ko } from "../../../../../../packages/i18n/src/catalogs/ko";
import { en } from "../../../../../../packages/i18n/src/catalogs/en";
import { approvalSummary, domainSummary, numberingSummary, titlesSummary, periodsSummary, settingLabel, settingValue } from "./summaries";

const t = (id: string, values: Record<string, string | number> = {}) => ((ko as Record<string, string>)[id] ?? ko["settingsHub.unknown"] ?? "확인 불가").replace(/\{(\w+)(?:, number)?\}/g, (_, key) => String(values[key]));
const date = (value: string) => value;
const keys = ["org_structure", "people_correction", "identity_merge", "registration_void", "exit", "import_rollback"];
const entry = (key = keys[0]!): components["schemas"]["SettingEntry"] => ({
  key: `approval.policy.${key}`, kind: { type: "code", allowed: ["route", "none"] }, default: "none", value: "none",
  looser_when: "higher", governance: "tenant", legal_basis: null, version: "code_default", effective_from: null,
  source: { layer: "tenant", scope_entity_id: null }, chain: [], scheduled: [],
});

test("every displayed policy key has Korean and English copy; unknown keys are never exposed", () => {
  for (const key of keys.map(name => entry(name).key)) for (const catalog of [ko, en]) {
    expect((catalog as Record<string, string>)[`settingsHub.key.${key}`]).toBeTruthy();
  }
  expect(settingLabel("approval.policy.unlabelled", t)).toBe(t("settingsHub.unknown"));
});

test("area summaries use only served values and distinguish empty data", () => {
  expect(domainSummary({ pending_domain: "example.test" }, t, "operator@current.test")).toBe("current.test · example.test · 신청 중");
  expect(domainSummary({ pending_domain: null }, t, "operator@current.test")).toBe("current.test");
  expect(domainSummary({ pending_domain: null }, t, null)).toBe("확인 불가");
  expect(domainSummary({ pending_domain: "example.test" }, t, "operator")).toBe("확인 불가");
  expect(numberingSummary([], t)).toBe("규칙 없음");
  expect(numberingSummary([{ scope_kind: "WORKPLACE", scope_id: "workplace", prefix: "W-", width: 4, next_number: "W-0001" }], t)).toBe("규칙 없음");
  expect(numberingSummary([{ scope_kind: "TENANT", scope_id: "tenant", prefix: "E-", width: 4, next_number: "E-0012" }], t)).toBe("E-0012");
  expect(periodsSummary({ items: [] }, t, date)).toBe("마감 없음");
});

test("job title counts use each kind's enum label and exclude inactive rows", () => {
  const items: Parameters<typeof titlesSummary>[0]["items"] = [
    { id: "a", kind: "GRADE", label: "대리", grade_rank: 1, active: true },
    { id: "b", kind: "TITLE", label: "선임", grade_rank: null, active: true },
    { id: "c", kind: "POSITION", label: "팀장", grade_rank: null, active: true },
    { id: "d", kind: "TITLE", label: "책임", grade_rank: null, active: true },
    { id: "e", kind: "GRADE", label: "과장", grade_rank: 2, active: false },
    { id: "f", kind: "JOB", label: "개발", grade_rank: null, active: true },
  ];
  expect(titlesSummary({ can_manage: false, items }, t)).toBe("직급 1 · 직위 2 · 직책 1 · 직무 1");
  const english: typeof t = (id, values) => ((en as Record<string, string>)[id] ?? "Unavailable").replace(/\{(\w+)(?:, number)?\}/g, (_, key) => String(values?.[key]));
  expect(titlesSummary({ can_manage: false, items }, english)).toBe("Grade 1 · Title 2 · Position 1 · Job 1");
  expect(titlesSummary({ can_manage: false, items: [] }, t)).toBe("등록된 항목 없음");
  expect(titlesSummary({ can_manage: false, items: items.filter(row => !row.active) }, t)).toBe("등록된 항목 없음");
});

test("identical policy hints collapse while distinct scopes and scheduled changes remain visible", () => {
  const items = keys.map(key => ({ ...entry(key), governance: "fixed" as const, source: { layer: "platform" as const, scope_entity_id: null } }));
  expect(approvalSummary({ can_change: false, items }, t, date).hints).toEqual(["모두 · 플랫폼에서 정함 · 고정값", "읽기 전용"]);
  const mixed = approvalSummary({ can_change: true, items: [items[0]!, { ...entry("exit"), source: { layer: "legal_entity", scope_entity_id: "entity" }, scheduled: [{ id: "next", value: "route", scope_entity_id: "entity", effective_from: "2026-12-01" }] }] }, t, date);
  expect(mixed.hints).toEqual(["조직 개편 · 플랫폼에서 정함 · 고정값", "퇴직 확인 · 법인에서 정함", "2026-12-01부터 퇴직 확인 · 결재"]);
});

test("latest active closed period is selected per domain, regardless of response order", () => {
  const lock = (domain: "payroll" | "accounting", periodEnd: string, active = true) => ({ id: periodEnd, domain, periodStart: "2026-01-01", periodEnd, lockedAt: "2026-10-01T00:00:00Z", reason: "", active, unlockReviewRequired: false });
  const result = periodsSummary({ items: [lock("payroll", "2026-08-31"), lock("payroll", "2026-10-31", false), lock("payroll", "2026-09-30"), lock("accounting", "2026-07-31")] }, t, date);
  expect(result).toContain("2026-09-30");
  expect(result).toContain("2026-07-31");
  expect(result).not.toContain("2026-08-31");
  expect(result).not.toContain("2026-10-31");
});

test("approval summary derives classes by prefix and keeps scheduled, inherited and fixed facts", () => {
  const routed = { ...entry(), value: "route", governance: "fixed" as const, source: { layer: "platform" as const, scope_entity_id: null }, scheduled: [{ id: "later", value: "none", scope_entity_id: null, effective_from: "2026-12-01T00:00:00Z" }] };
  const result = approvalSummary({ can_change: false, items: [routed, entry("exit"), { ...entry(), key: "other.key", value: "route" }] }, t, date);
  expect(result.value).toBe("조직 개편");
  expect(result.hints.join(" ")).toContain("2026-12-01");
  expect(result.hints.join(" ")).toContain("바로 적용");
  expect(result.hints.join(" ")).toContain("플랫폼");
  expect(result.hints.join(" ")).toContain("고정");
  expect(result.hints.join(" ")).toContain("읽기 전용");
  expect(approvalSummary({ can_change: true, items: [entry()] }, t, date)).toEqual({ value: "모두 바로 적용", hints: [] });
  expect(approvalSummary({ can_change: true, items: [entry("unlabelled")] }, t, date).value).toBe("확인 불가");
  expect(approvalSummary({ can_change: true, items: [] }, t, date).value).toBe("확인 불가");
  expect(approvalSummary({ can_change: true, items: [{ ...entry(), value: "unexpected" }] }, t, date).value).toBe("확인 불가");
});

test("setting values preserve false, zero and unknown codes", () => {
  expect(settingValue({ ...entry(), kind: { type: "bool" } }, false, t)).toBe("꺼짐");
  expect(settingValue({ ...entry(), kind: { type: "bool" } }, true, t)).toBe("켜짐");
  expect(settingValue({ ...entry(), kind: { type: "int", unit: "days" } }, 0, t)).toBe("0일");
  expect(settingValue({ ...entry(), kind: { type: "int" } }, null, t)).toBe("확인 불가");
  expect(settingValue({ ...entry(), kind: { type: "bool" } }, "route", t)).toBe("확인 불가");
  expect(settingValue(entry(), null, t)).toBe("확인 불가");
  expect(settingValue(entry(), "unlabelled", t)).toBe("확인 불가");
});

test("fresh tenant code defaults add no inherited hints for all served policy keys", () => {
  const items = keys.map(key => ({ ...entry(key), source: { layer: "code_default" as const, scope_entity_id: null } }));
  expect(approvalSummary({ can_change: true, items }, t, date)).toEqual({ value: "모두 바로 적용", hints: [] });
});

test("approval values follow served allowed kinds and routed classes omit the repeated card title", () => {
  const restricted: components["schemas"]["SettingEntry"] = { ...entry(), kind: { type: "code", allowed: ["none"] }, value: "route" };
  expect(approvalSummary({ can_change: true, items: [restricted] }, t, date).value).toBe("확인 불가");
  expect(approvalSummary({ can_change: true, items: [entry(), { ...entry("identity_merge"), value: "route" }, { ...entry("exit"), value: "route" }] }, t, date).value).toBe("동일인 병합, 퇴직 확인");
});
