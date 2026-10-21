import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import type { PeriodLock } from "./api";
import { closedText, lockRefusal } from "./present";

beforeAll(async () => {
  await loadCatalog("ko");
  await loadCatalog("en");
});

const lock = (over: Partial<PeriodLock> = {}) =>
  ({ id: "l1", domain: "payroll", periodStart: "2026-09-01", periodEnd: "2026-09-30", reason: "", lockedBy: "u1", lockedByName: "김마감", lockedAt: "2026-10-01T06:00:00Z", unlockReviewRequired: false, active: true, ...over }) as PeriodLock;

// regression (governance-09, worst-case-04, governance-33): the refusal printed ISO ranges and named no lock.
test("a closed period is named by its domain, month, locker and time in Korean dates, never ISO", () => {
  i18n.set("ko");
  expect(closedText(lock())).toBe("급여 · 2026년 9월 마감 (김마감 · 2026. 10. 01. 15:00 KST)");
  expect(closedText(lock({ lockedBy: undefined, lockedByName: undefined }))).toContain("(자동 다시 잠금 · ");
  expect(closedText(lock({ lockedByName: undefined }))).toContain("(삭제된 계정 · ");
  const r = lockRefusal(lock(), "2026-09-15", false);
  expect(r.reason).toBe("2026. 09. 15.은 잠긴 기간에 속합니다: 급여 · 2026년 9월 마감 (김마감 · 2026. 10. 01. 15:00 KST)");
  expect(`${r.title} ${r.reason} ${r.remedy}`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(r.remedy).toContain("잠금을 해제하면");
  expect(lockRefusal(lock(), "2026-09-15", true).remedy).toContain("패스키");
  expect(r.exception).toBe("예외 요청은 아직 제공하지 않습니다.");
});

test("the same facts read in English", () => {
  i18n.set("en");
  expect(closedText(lock())).toBe("Payroll · September 2026 closed (김마감 · 10/01/2026, 15:00 KST)");
  i18n.set("ko");
});
