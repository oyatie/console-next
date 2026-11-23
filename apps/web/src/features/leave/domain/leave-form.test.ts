// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import {
  buildLeaveCreatePayload,
  computeRequestedDays,
  formatLeaveDays,
  listScheduleMonths,
  parseLeaveUnits,
  validateLeaveDates,
} from "./leave-form";

describe("leave-form domain helpers", () => {
  test("parses 6-decimal backend units without coercing null or whitespace to zero", () => {
    expect(parseLeaveUnits("15.000000")).toBe(15);
    expect(parseLeaveUnits("5.500000")).toBe(5.5);
    expect(parseLeaveUnits(null)).toBeNull();
    expect(parseLeaveUnits(undefined)).toBeNull();
    expect(parseLeaveUnits("")).toBeNull();
    expect(parseLeaveUnits("   ")).toBeNull();
    expect(formatLeaveDays(15)).toBe("15");
    expect(formatLeaveDays(8.5)).toBe("8.5");
  });

  test("half-day requests always deduct 0.5 and lock end_date to start_date without reason", () => {
    expect(
      computeRequestedDays({
        kind: "half_am",
        startDate: "2026-11-20",
        endDate: "2026-11-23",
      }),
    ).toBe(0.5);

    const payload = buildLeaveCreatePayload({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      kind: "half_pm",
      startDate: "2026-11-20",
      endDate: "2026-11-23",
    });
    expect(payload).toEqual({
      idempotency_key: "11111111-1111-4111-8111-111111111111",
      leave_type: "half_day",
      partial_day_period: "pm",
      start_date: "2026-11-20",
      end_date: "2026-11-20",
    });
    expect("reason" in payload).toBe(false);
  });

  test("annual multi-day calculation skips non-working schedule holidays and falls back to calendar days", () => {
    const scheduleByDate = new Map([
      ["2026-11-20", "WORK" as const],
      ["2026-11-21", "WEEKLY_HOLIDAY" as const],
      ["2026-11-22", "WEEKLY_HOLIDAY" as const],
      ["2026-11-23", "WORK" as const],
    ]);
    expect(
      computeRequestedDays({
        kind: "annual",
        startDate: "2026-11-20",
        endDate: "2026-11-23",
        scheduleByDate,
      }),
    ).toBe(2);

    expect(
      computeRequestedDays({
        kind: "annual",
        startDate: "2026-11-20",
        endDate: "2026-11-23",
      }),
    ).toBe(4);

    const payload = buildLeaveCreatePayload({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      kind: "annual",
      startDate: "2026-11-20",
      endDate: "2026-11-23",
    });
    expect(payload).toEqual({
      idempotency_key: "22222222-2222-4222-8222-222222222222",
      leave_type: "annual",
      start_date: "2026-11-20",
      end_date: "2026-11-23",
    });
    expect("reason" in payload).toBe(false);
  });

  test("validates end_before_start and 366-day max range boundaries", () => {
    expect(validateLeaveDates("2026-11-20", "2026-11-19")).toBe("end_before_start");
    expect(validateLeaveDates("2026-11-20", "2026-11-20")).toBeNull();
    expect(validateLeaveDates("2026-01-01", "2027-01-01")).toBeNull();
    expect(validateLeaveDates("2026-01-01", "2027-01-02")).toBe("range_max");
  });

  test("lists all months across 3+-month spans and applies weekend fallback for unloaded months", () => {
    expect(listScheduleMonths("2026-10-30", "2026-12-03")).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(listScheduleMonths("2026-01-01", "2027-01-01")).toHaveLength(13);
    expect(listScheduleMonths("2026-01-01", "2027-01-02")).toEqual([]);

    const scheduleByDate = new Map<string, "WORK" | "WEEKLY_HOLIDAY">();
    const loadedThree = new Set(["2026-10", "2026-11", "2026-12"]);
    for (const [month, count] of [
      ["2026-10", 31],
      ["2026-11", 30],
      ["2026-12", 31],
    ] as const) {
      for (let d = 1; d <= count; d++) {
        const iso = `${month}-${String(d).padStart(2, "0")}`;
        const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
        scheduleByDate.set(iso, dow === 0 || dow === 6 ? "WEEKLY_HOLIDAY" : "WORK");
      }
    }
    // 2026-10-30..2026-12-03: 1 (Oct 30) + 21 (Nov) + 3 (Dec 1..3) = 25 working days
    expect(
      computeRequestedDays({
        kind: "annual",
        startDate: "2026-10-30",
        endDate: "2026-12-03",
        scheduleByDate,
        loadedMonths: loadedThree,
      }),
    ).toBe(25);

    // Partial 503: 2026-11 loaded, 2026-12 failed -> 2026-11-27..2026-12-06 skips Dec 5 (Sat) & Dec 6 (Sun) = 6 days
    const novOnlyMap = new Map([...scheduleByDate].filter(([date]) => date.startsWith("2026-11")));
    expect(
      computeRequestedDays({
        kind: "annual",
        startDate: "2026-11-27",
        endDate: "2026-12-06",
        scheduleByDate: novOnlyMap,
        loadedMonths: new Set(["2026-11"]),
      }),
    ).toBe(6);
  });
});
