import { expect, test } from "vitest";
import type { LegalEntity } from "@console/api/pending";
import { dateOf, dayBefore, effectiveFrom, entityRevision, keepsOldPeriod, nextMonthFirst, revProblem } from "./revise";

test("the date chips resolve to today, the first of next month (across a year end) or the typed date; none is preselected", () => {
  expect(nextMonthFirst("2026-10-06")).toBe("2026-11-01");
  expect(nextMonthFirst("2026-12-31")).toBe("2027-01-01");
  expect(dateOf(null, "2026-10-15", "2026-10-06")).toBe("");
  expect(dateOf("typed", "2026-10-15", "2026-10-06")).toBe("2026-10-15");
  expect(dayBefore("2026-03-01")).toBe("2026-02-28");
});

test("a change takes its chosen date and may not start before the period in force; a correction rewrites that period", () => {
  expect(effectiveFrom("rev", "2026-11-01", "2026-09-15")).toBe("2026-11-01");
  expect(effectiveFrom("cor", "", "2026-09-15")).toBe("2026-09-15");
  expect(revProblem("2026-09-14", "2026-09-15")).toBe("beforeInForce");
  expect(revProblem("2026-09-15", "2026-09-15")).toBeNull();
  // regression: company-21 a change on the day the value began showed the period "10. 07. ~ 10. 06.".
  expect(keepsOldPeriod("2026-09-15", "2026-09-15")).toBe(false);
  expect(keepsOldPeriod("2026-09-16", "2026-09-15")).toBe(true);
  expect(revProblem("2026-10-20", "2026-10-06", "2026-11-01")).toBe("beforeScheduled");
  expect(revProblem("2026-11-01", "2026-10-06", "2026-11-01")).toBeNull();
});

test("a change dated after a scheduled one builds on it, so the scheduled change is carried; one before it is not", () => {
  const state = (version: number, from: string, reps: string[]) => ({ version, effective_from: from, before_first_record: false, name: "(주)새온정밀", additional_representatives: 0, change_mode: "SETUP" as const, representatives: reps, representation_mode: reps.length > 1 ? ("SEVERAL" as const) : ("SINGLE" as const) });
  const e = { id: "e1", biz_kind: "CORPORATION", current: state(1, "2026-10-06", ["홍길동"]), scheduled: [state(2, "2026-11-01", ["홍길동", "한지원"])] } as unknown as LegalEntity;
  expect(entityRevision(e, { main_phone: "+8225550142" }, "rev", "2026-12-01")).toMatchObject({ representatives: ["홍길동", "한지원"], effective_from: "2026-12-01", expected_version: 2 });
  expect(entityRevision(e, { main_phone: "+8225550142" }, "rev", "2026-10-20")).toMatchObject({ representatives: ["홍길동"] });
  expect(entityRevision(e, { main_phone: "+8225550142" }, "cor", "")).toMatchObject({ representatives: ["홍길동"], effective_from: "2026-10-06" });
});
