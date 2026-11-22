// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { countOpenOwnExceptions, countScheduledWorkDays, isoMondayOf, nextPunchKind, shiftIsoWeek } from "./week";

test("isoMondayOf snaps any day of the week to its ISO Monday", () => {
  expect(isoMondayOf("2026-11-09")).toBe("2026-11-09");
  expect(isoMondayOf("2026-11-10")).toBe("2026-11-09");
  expect(isoMondayOf("2026-11-15")).toBe("2026-11-09");
  expect(isoMondayOf("2026-11-08")).toBe("2026-11-02");
});

test("shiftIsoWeek steps across week boundaries cleanly", () => {
  expect(shiftIsoWeek("2026-11-10", -1)).toBe("2026-11-02");
  expect(shiftIsoWeek("2026-11-10", 1)).toBe("2026-11-16");
});

test("countScheduledWorkDays and countOpenOwnExceptions aggregate server records", () => {
  expect(countScheduledWorkDays(undefined)).toBe(0);
  expect(
    countScheduledWorkDays({
      scope_kind: "PERSON",
      scope_id: "e1",
      scope_name: "Test",
      month: "2026-11",
      holidays_loaded: true,
      stack: [],
      upcoming: [],
      days: [
        { date: "2026-11-02", kind: "WORK", holiday_work: false },
        { date: "2026-11-03", kind: "WORK", holiday_work: false },
        { date: "2026-11-07", kind: "REST_DAY", holiday_work: false },
      ],
    }),
  ).toBe(2);

  expect(
    countOpenOwnExceptions([
      {
        id: "1",
        code: "LATE",
        kind: "LATE",
        status: "OPEN",
        work_date: "2026-11-03",
        occurred_at: "2026-11-03T09:10:00Z",
        detail: "Late",
        evidence: [],
        created_at: "2026-11-03T09:10:00Z",
      },
      {
        id: "2",
        code: "LATE",
        kind: "LATE",
        status: "RESOLVED",
        work_date: "2026-11-02",
        occurred_at: "2026-11-02T09:10:00Z",
        detail: "Resolved",
        evidence: [],
        created_at: "2026-11-02T09:10:00Z",
      },
    ]),
  ).toBe(1);
});

test("nextPunchKind toggles between CLOCK_IN and CLOCK_OUT from latest state", () => {
  expect(nextPunchKind(undefined)).toBe("CLOCK_IN");
  expect(nextPunchKind([])).toBe("CLOCK_IN");
  expect(
    nextPunchKind([
      {
        id: "r1",
        employee_id: "e1",
        employee_display_name: "Test",
        kind: "CLOCK_IN",
        occurred_at: "2026-11-10T00:00:00Z",
        work_date: "2026-11-10",
        state_after: "CLOCKED_IN",
        payroll_material_ref_id: "p1",
        payroll_link_status: "LINKED",
        duplicate: false,
      },
    ]),
  ).toBe("CLOCK_OUT");
});
