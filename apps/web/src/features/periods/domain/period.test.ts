import { describe, expect, it } from "vitest";
import { datedWithin, inForce, lockCovering, lastUnlockDay, monthWindow, relockAt, overlapping, recentMonths, sameLock, shiftedStart, wholeMonth, windowDays } from "./period";

const lock = (id: string, domain: string, periodStart: string, periodEnd: string, unlockedAt?: string) => ({ id, domain, periodStart, periodEnd, unlockedAt });

describe("period windows", () => {
  it("derives a month's first and last day, leap years included", () => {
    expect(monthWindow("2026-09")).toEqual({ periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    expect(monthWindow("2028-02")).toEqual({ periodStart: "2028-02-01", periodEnd: "2028-02-29" });
    expect(monthWindow("2026-12")).toEqual({ periodStart: "2026-12-01", periodEnd: "2026-12-31" });
  });
  it("lists the twelve finished months before today, newest first, across a year end", () => {
    const months = recentMonths("2026-01-15");
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2025-12");
    expect(months[11]).toBe("2025-01");
    expect(recentMonths("2026-10-02")[0]).toBe("2026-09");
  });
  it("recognises a whole month and counts days inclusively", () => {
    expect(wholeMonth({ periodStart: "2026-09-01", periodEnd: "2026-09-30" })).toBe("2026-09");
    expect(wholeMonth({ periodStart: "2026-09-01", periodEnd: "2026-09-15" })).toBeNull();
    expect(windowDays({ periodStart: "2026-09-01", periodEnd: "2026-09-30" })).toBe(30);
    expect(windowDays({ periodStart: "2026-09-01", periodEnd: "2026-09-01" })).toBe(1);
  });
});

describe("overlap", () => {
  const locks = [lock("a", "payroll", "2026-08-01", "2026-08-31"), lock("b", "payroll", "2026-07-01", "2026-07-31", "2026-08-02T00:00:00Z")];
  it("finds an active lock in the same domain that the window touches, ends included", () => {
    expect(overlapping(locks, "payroll", { periodStart: "2026-08-31", periodEnd: "2026-09-15" })?.id).toBe("a");
    expect(overlapping(locks, "payroll", { periodStart: "2026-09-01", periodEnd: "2026-09-30" })).toBeUndefined();
    expect(overlapping(locks, "accounting", { periodStart: "2026-08-15", periodEnd: "2026-08-20" })).toBeUndefined();
    // An unlocked lock no longer blocks.
    expect(overlapping(locks, "payroll", { periodStart: "2026-07-10", periodEnd: "2026-07-20" })).toBeUndefined();
  });
  it("offers the day after the other lock only when the overlap is at the start", () => {
    const a = locks[0]!;
    expect(shiftedStart({ periodStart: "2026-08-15", periodEnd: "2026-09-15" }, a)).toBe("2026-09-01");
    expect(shiftedStart({ periodStart: "2026-07-15", periodEnd: "2026-08-15" }, a)).toBeNull();
    expect(shiftedStart({ periodStart: "2026-08-10", periodEnd: "2026-08-20" }, a)).toBeNull();
    expect(shiftedStart({ periodStart: "2026-07-15", periodEnd: "2026-09-15" }, a)).toBeNull();
  });
  it("finds the user's own lock after a lost response, not a foreign overlap", () => {
    const w = { periodStart: "2026-08-01", periodEnd: "2026-08-31" };
    expect(sameLock(locks, "payroll", w)?.id).toBe("a");
    expect(sameLock(locks, "payroll", { ...w, periodEnd: "2026-08-30" })).toBeUndefined();
  });
});

describe("org changes dated inside a window", () => {
  it("keeps the changes whose effective date falls in the window, ends included", () => {
    const changes = [{ effectiveDate: "2026-08-31" }, { effectiveDate: "2026-09-01" }, { effectiveDate: "2026-09-30" }, { effectiveDate: "2026-10-01" }];
    expect(datedWithin(changes, { periodStart: "2026-09-01", periodEnd: "2026-09-30" })).toEqual([{ effectiveDate: "2026-09-01" }, { effectiveDate: "2026-09-30" }]);
  });
});

it("an unlock runs to the end of its last day and stays within the setting's maximum", () => {
  expect(relockAt("2026-10-04")).toBe("2026-10-05T00:00:00+09:00");
  expect(lastUnlockDay("2026-10-04", 7)).toBe("2026-10-10");
  expect(lastUnlockDay("2026-10-04", 1)).toBe("2026-10-04");
});

it("a lock is in force by the server's word; an unlocked one whose window passed is in force again", () => {
  const w = { id: "l", domain: "payroll", periodStart: "2026-09-01", periodEnd: "2026-09-30" };
  expect(inForce({ ...w })).toBe(true);
  expect(inForce({ ...w, unlockedAt: "x" })).toBe(false);
  expect(inForce({ ...w, unlockedAt: "x", active: true })).toBe(true);
});

// regression (governance-09, worst-case-04): a dated write in a locked month is named before commit, by its lock.
it("finds the lock in force whose window holds a date, ends included; unlocked or other domains do not", () => {
  const locks = [
    { ...lock("new", "payroll", "2026-09-01", "2026-09-30"), active: true },
    lock("old", "payroll", "2026-08-01", "2026-08-31", "2026-09-02T00:00:00Z"),
    lock("acc", "accounting", "2026-09-01", "2026-09-30"),
  ];
  expect(lockCovering(locks, "2026-09-15")?.id).toBe("new");
  expect(lockCovering(locks, "2026-09-30", "accounting")?.id).toBe("acc");
  expect(lockCovering(locks, "2026-08-15")).toBeUndefined();
  expect(lockCovering(locks, "2026-10-01")).toBeUndefined();
});

