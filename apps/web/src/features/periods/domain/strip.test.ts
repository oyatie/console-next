import { expect, test } from "vitest";
import { daysLeft, monthStrip, step } from "./strip";

const lock = (id: string, domain: string, periodStart: string, periodEnd: string, extra: object = {}) => ({ id, domain, periodStart, periodEnd, ...extra });

test("each finished month, oldest first: locked, open until its re-lock, or open", () => {
  const locks = [
    lock("sep", "payroll", "2026-09-01", "2026-09-30", { active: true }),
    lock("aug", "payroll", "2026-08-01", "2026-08-31", { unlockedAt: "2026-10-01T00:00:00Z", relockAt: "2026-10-09T00:00:00+09:00", active: false }),
    lock("jul-old", "payroll", "2026-07-01", "2026-07-31", { unlockedAt: "2026-08-01T00:00:00Z", relockAt: "2026-08-02T00:00:00+09:00", active: true }),
    lock("acc", "accounting", "2026-09-01", "2026-09-30", { active: true }),
  ];
  const strip = monthStrip(locks, "payroll", "2026-10-07");
  expect(strip).toHaveLength(12);
  expect(strip[0]!.month).toBe("2025-10");
  expect(strip.slice(-3).map((c) => [c.month, c.state])).toEqual([["2026-07", "locked"], ["2026-08", "unlocked"], ["2026-09", "locked"]]);
  expect(strip[10]).toMatchObject({ state: "unlocked", relockAt: "2026-10-09T00:00:00+09:00" });
  expect(monthStrip(locks, "accounting", "2026-10-07").filter((c) => c.state !== "open").map((c) => c.month)).toEqual(["2026-09"]);
  // A custom range touching two months locks both.
  expect(monthStrip([lock("x", "payroll", "2026-05-20", "2026-06-10", { active: true })], "payroll", "2026-10-07").filter((c) => c.state === "locked").map((c) => c.month)).toEqual(["2026-05", "2026-06"]);
});

test("days left before an automatic re-lock, and the grid's keyboard moves", () => {
  const now = Date.parse("2026-10-07T03:00:00Z");
  expect(daysLeft("2026-10-09T00:00:00+09:00", now)).toBe(2);
  expect(daysLeft("2026-10-08T00:00:00+09:00", now)).toBe(1);
  expect(daysLeft("2026-10-01T00:00:00+09:00", now)).toBe(0);
  expect(step("ArrowRight", { row: 0, col: 11 }, 2, 12)).toEqual({ row: 0, col: 11 });
  expect(step("ArrowDown", { row: 0, col: 3 }, 2, 12)).toEqual({ row: 1, col: 3 });
  expect(step("Home", { row: 1, col: 3 }, 2, 12)).toEqual({ row: 1, col: 0 });
  expect(step("l", { row: 0, col: 0 }, 2, 12)).toBeNull();
});
