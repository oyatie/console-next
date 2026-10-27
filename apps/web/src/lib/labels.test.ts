// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { isMessageId, loadCatalog, t } from "@console/i18n";
import { LEAVE_TYPE, actor, label, labeled } from "./labels";
import * as enums from "./labels";
import type { Enum } from "./labels";

beforeAll(() => loadCatalog("ko"));

test("unnamed actors retain a visible person label", () => {
  for (const name of ["", "   "]) expect(actor(name)).toBe("이름 미등록");
  expect(actor(" 박관리자 ")).toBe("박관리자");
  expect(actor(null)).toBe("—");
});

test("unknown leave types have a neutral label and a separate diagnostic code", () => {
  expect(label(LEAVE_TYPE, "FUTURE_LEAVE")).toBe("확인되지 않은 항목");
  expect(labeled(LEAVE_TYPE, "FUTURE_LEAVE")).toEqual({ label: "확인되지 않은 항목", tone: "neutral", code: "FUTURE_LEAVE" });
  expect(label(LEAVE_TYPE, "WORK_INJURY")).toBe("산재 요양");
});

test("known leave choices remain checked by TypeScript", () => {
  // @ts-expect-error A future response is readable, but a misspelled command choice is not valid.
  const typo: (typeof LEAVE_TYPE.values)[number] = "CHILDCAR";
  expect(LEAVE_TYPE.values).not.toContain(typo);
});

// Status enums are checked independently of their page callers.
const statuses = [
  enums.ACCOUNT_STATUS, enums.TENANT_LIFECYCLE, enums.TENANT_STATUS,
  enums.ORG_CHANGE_STATUS, enums.STEP_DECISION, enums.EMPLOYEE_STATUS,
  enums.UNIT_STATUS, enums.IMPORT_CLASSIFICATION, enums.EXIT_CASE_STATUS,
  enums.SETTLEMENT_STATUS, enums.LIFECYCLE_STATE, enums.IMPORT_ROW_STATUS,
  enums.PROBATION_STATE, enums.RECORD_STATUS, enums.INSURANCE_STATUS,
  enums.VERIFICATION, enums.CHANGE_MODE,
];

function expectTones(e: Enum) {
  expect(e.values.length).toBeGreaterThan(0);
  expect(Object.keys(e.tone ?? {}).sort()).toEqual([...e.values].sort());
  for (const value of e.values) {
    expect(labeled(e, value).tone).toBe(e.tone?.[value]);
    expect(label(e, value)).not.toBe(value);
  }
}

test.each(statuses)("$type gives every state a catalog word and a tone", expectTones);

test("the status inventory check rejects a planted untoned enum", () => {
  expect(() => expectTones({ type: "plantedStatus", values: ["ACTIVE"] })).toThrow();
});

test("an unknown status stays visible with a neutral tone", () => {
  expect(labeled(enums.ORG_CHANGE_STATUS, "FUTURE_STATUS")).toEqual({ label: "FUTURE_STATUS", tone: "neutral" });
});

test("an unknown support session keeps the unrecognized word and diagnostic code", () => {
  expect(labeled(enums.SUPPORT_SESSION_STATE, "FUTURE_SESSION")).toEqual({ label: "확인되지 않은 항목", tone: "neutral", code: "FUTURE_SESSION" });
});

const migrated = [
  [enums.IMPORT_OUTCOME, "import.outcome", ["ok", "info", "neutral", "neutral", "danger", "warn"]],
  [enums.IMPORT_RUN_STATUS, "import.status", ["neutral", "neutral", "neutral", "ok", "danger", "warn", "warn", "neutral"]],
  [enums.IMPORT_SHEET_STATUS, "importSheet.status", ["ok", "danger", "neutral", "neutral"]],
  [enums.SUPPORT_SESSION_STATE, "supportAccess.state", ["neutral", "neutral", "warn", "neutral", "neutral", "neutral", "neutral"]],
  [enums.ATTENDANCE_PATTERN_STATUS, "attendancePatterns.patternStatus", ["ok", "neutral"]],
] as const;

test.each(migrated.map(([e, prefix, tones]) => ({ e, prefix, tones })))("$e.type reuses the existing catalog and preserves every state tone", ({ e, prefix, tones }) => {
  expect(e).toBeDefined();
  expect(Object.keys(e.tone ?? {}).sort()).toEqual([...e.values].sort());
  expect(Object.values(e.tone ?? {})).toEqual(tones);
  for (const value of e.values) {
    const key = e === enums.IMPORT_RUN_STATUS && value === "FAILED" ? "importJob.failed"
      : `${prefix}.${value === "PREVIEWED" ? "PREVIEW" : value}`;
    expect(labeled(e, value)).toEqual({ label: t(key as Parameters<typeof t>[0]), tone: (e as Enum).tone?.[value] });
  }
  expect(labeled(e, "FUTURE_STATE").tone).toBe("neutral");
});

const remaining = [
  [enums.ATTENDANCE_MARK, "attendanceRecords.mark", ["danger", "danger", "danger", "warn", "warn", "info", "info", "info", "info"]],
  [enums.ORG_BULK_PLAN_STATUS, "orgBulk.plan.status", ["neutral", "ok", "ok", "danger", "danger", "danger"]],
  [enums.ATTENDANCE_LAYER_STATE, "attendance.state", ["info", "ok", "neutral", "neutral"]],
  [enums.CHANGE_REQUEST_STATUS, "requests.status", ["warn", "ok", "danger", "neutral"]],
  [enums.ACCESS_ENFORCEMENT, "accessCodes.enforcement", ["ok", "info", "info", "neutral", "neutral", "warn", "warn", "neutral"]],
  [enums.IMPORT_RECONCILE_STATE, "importReconcile.state", ["neutral", "ok", "warn"]],
  [enums.PERIOD_UNLOCK_STATE, "periodLocks.request.chip", ["info", "danger", "neutral"]],
  [enums.JOB_TITLE_STATUS, "titles", ["ok", "neutral"]],
  [enums.ENTITY_LIFECYCLE, "entityRecord.status", ["ok", "neutral", "info"]],
  [enums.IDENTIFIER_CORRECTION_STATUS, "entityRecord.corrections.status", ["warn", "neutral", "neutral", "warn", "neutral", "neutral", "neutral"]],
  [enums.STRUCTURE_RECORD_STATE, "structure.chip", ["warn", "warn", "warn", "neutral", "neutral"]],
  [enums.SETTLEMENT_CERTIFICATION_STATE, "exit.settlement", ["warn"]],
] as const;

test.each(remaining.map(([e, prefix, tones]) => ({ e, prefix, tones })))("$e.type replaces local tones without changing catalog words", ({ e, prefix, tones }) => {
  expect(e).toBeDefined();
  expectTones(e);
  expect(Object.values(e.tone ?? {})).toEqual(tones);
  for (const value of e.values) {
    const key = value === "founding" ? "entityOps.founding.chip" : value === "UNCERTIFIED_DRAFT" ? "exit.settlement.uncertified" : `${prefix}.${value}`;
    expect(label(e, value)).toBe(t(key as Parameters<typeof t>[0]));
  }
});

test.each([
  [enums.ATTENDANCE_MONTH_STATE, { OPEN: "warn", CLOSED: "info", REOPENED: "warn" }],
  [enums.WORKPLACE_CLOSE_STATE, { SCHEDULED: "info", WAITING: "warn", APPLIED: "neutral", FAILED: "danger", CANCELLED: "neutral" }],
  [enums.ORG_BULK_SITE_STATE, { open: "warn", done: "ok" }],
  [enums.IMPORT_SIGNOFF_STATE, { stateOpen: "warn", stateDone: "ok" }],
  [enums.ENTITY_PHASE, { setup: "ok", operating: "info" }],
].map(([e, tones]) => ({ e: e as Enum, tones })))("$e.type centralizes contextual status tones", ({ e, tones }) => {
  expect(e).toBeDefined();
  expect(Object.keys(e.tone ?? {}).sort()).toEqual([...e.values].sort());
  expect(e.tone).toEqual(tones);
  for (const value of e.values) expect(isMessageId(e.message!(value))).toBe(true);
});
