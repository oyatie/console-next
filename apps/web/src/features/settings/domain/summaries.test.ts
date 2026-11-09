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
  expect(domainSummary({ pending_domain: "example.test" }, t)).toBe("example.test · 신청 중");
  expect(domainSummary({ pending_domain: null }, t)).toBe("신청 전");
  expect(numberingSummary([], t)).toBe("규칙 없음");
  expect(numberingSummary([{ scope_kind: "WORKPLACE", scope_id: "workplace", prefix: "W-", width: 4, next_number: "W-0001" }], t)).toBe("규칙 없음");
  expect(numberingSummary([{ scope_kind: "TENANT", scope_id: "tenant", prefix: "E-", width: 4, next_number: "E-0012" }], t)).toBe("E-0012");
  expect(titlesSummary({ can_manage: false, items: [{ id: "a", kind: "GRADE", label: "대리", grade_rank: null, active: true }, { id: "b", kind: "POSITION", label: "팀장", grade_rank: null, active: true }, { id: "c", kind: "TITLE", label: "사내 호칭", grade_rank: null, active: true }] }, t)).toBe("직위 1 · 직책 1");
  expect(periodsSummary({ items: [] }, t, date)).toBe("마감 없음");
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
  expect(result.value).toBe("조직 개편 · 결재");
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
  expect(settingValue(entry(), null, t)).toBe("확인 불가");
  expect(settingValue(entry(), "unlabelled", t)).toBe("확인 불가");
});
