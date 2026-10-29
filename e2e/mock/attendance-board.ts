// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import type { attendanceBoardScreens, AttendanceState } from "../states/attendance";
import { AT, failure, id } from "./fixtures";
import { mockRoute } from "./route";

type S = components["schemas"];
const attendanceTotals: S["AttendanceGridTotals"] = { recognised: 480, approved: 0, unrecognised: 0, not_worked: 0, blocking: 1, decision: 0 };
const marks = { blocking: 1, decision: 0, info: 0 };
const attendanceDays: S["AttendanceDay"][] = [480, 1320].map((start, i) => ({
  date: "2026-10-04", plan: { kind: "WORK", holiday_work: false, shift: { start, end: start + 480, breaks: [] } },
  marks: i ? ["NO_RECORD"] : ["LATE"],
  recognition: { recorded: 0, recognised: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, late_in: 0, early_out: 0, away: 0, approval_unused: 0 },
}));
const attendanceRows: S["AttendanceBoardRow"][] = attendanceDays.map((day, i) => ({
  employee_id: id(100 + i), employee_number: `AT-${i + 1}`, name: `근태직원 ${i + 1}`, own: false, day, month_state: { state: "OPEN" },
}));
export const attendancePerson: S["AttendancePersonMonth"] = {
  employee_id: id(100), employee_number: "AT-1", name: "근태직원 1", month: "2026-10", provisional: true, month_state: { state: "OPEN" },
  days: [...attendanceDays, { ...attendanceDays[0]!, date: "2026-10-05", plan: { kind: "WEEKLY_HOLIDAY", holiday_work: false }, marks: [] }], history: [], totals: attendanceTotals,
};
export const attendanceDayBoard: S["AttendanceDayBoard"] = {
  date: "2026-10-04", judged: true, marks,
  ledger: { people: 2, no_schedule: 0, rest: 0, normal: 0, no_record: 1, pending: 0, missing_out: 0, absent: 0, outside: 0, trip: 0, late_or_early: 1 },
  groups: [{ workplace_id: id(4), name: "본사", people: 2, normal: 0, no_schedule: 0, marks, hidden: 0, rows: attendanceRows }],
};
export const attendanceLayer: S["AttendanceScheduleLayer"] = {
  id: id(700), scope_kind: "WORKPLACE", scope_id: id(4), scope_name: "본사", pattern_id: id(701), pattern_name: "주간 근무",
  effective_from: "2099-01-01", reason: "STANDARD", state: "SCHEDULED", version: 1, created_at: AT, created_by_name: "근태담당",
};

/** Contract-shaped board states; held responses can be released without leaving pending routes behind. */
export async function attendanceBoardReads(page: Page, screen: typeof attendanceBoardScreens[number], state: AttendanceState) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const empty = state === "empty";
  await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: {
    date: "2026-10-04", people_total: empty ? 0 : 2, people_unscheduled: 0, holidays_loaded: true,
    nodes: empty ? [] : [{ id: id(4), name: "본사", kind: "WORKPLACE", people: 2, unscheduled: 0 }],
  } });
  await mockRoute(page, "get", "/api/v1/attendance/patterns", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/attendance/crews", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", { status: 200, json: { items: [attendanceLayer] } });
  await mockRoute(page, "post", "/api/v1/attendance/entries/preview", { status: 200, json: {
    cells: [{ employee_id: id(100), work_date: "2026-10-01", status: "OK", after: attendanceDays[0] }],
    ok: 1, unchanged: 0, refused: 0, conflicts: 0, closes: marks, opens: { blocking: 0, decision: 0, info: 0 },
  } });
  await mockRoute(page, "post", "/api/v1/attendance/entries", { status: 201, json: {
    batch_id: id(702), saved: 1, unchanged: 0, closes: marks, opens: { blocking: 0, decision: 0, info: 0 },
  } });
  const bodies = {
    "/api/v1/attendance/days": empty ? { ...attendanceDayBoard, groups: [], ledger: { ...attendanceDayBoard.ledger, people: 0, no_record: 0, late_or_early: 0 } } : attendanceDayBoard,
    "/api/v1/attendance/month": { month: "2026-10", people_total: empty ? 0 : 2, rows: empty ? [] : attendanceRows.map(row => ({
      ...row, totals: attendanceTotals, cells: Array.from({ length: 31 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, plan_kind: "WORK" as const, recognised: 0, unrecognised: 0, not_worked: 0, marks: i === 3 ? row.day.marks : [] })),
    })) } satisfies S["AttendanceMonthGrid"],
    "/api/v1/attendance/people/{employee_id}/month": empty ? { ...attendancePerson, days: [], history: [] } : attendancePerson,
    "/api/v1/attendance/schedule/calendar": { scope_kind: "WORKPLACE", scope_id: id(4), scope_name: "본사", month: "2026-10", stack: [], upcoming: [], holidays_loaded: true,
      days: [{ date: "2026-10-04", kind: "WEEKLY_HOLIDAY" }],
    } satisfies S["AttendanceScheduleCalendar"],
  };
  for (const [path, json] of Object.entries(bodies)) {
    const concrete = path.replace("{employee_id}", id(100));
    // 500 is the deliberate outage control, outside the operation's documented success responses.
    await page.route(url => url.pathname === concrete, async route => {
      if (path === screen.read && state === "loading") await held;
      const refused = path === screen.read && (state === "failed" || state === "refused");
      if (!page.isClosed()) await route.fulfill(refused ? { status: state === "failed" ? 500 : 403, json: failure(state === "failed" ? "internal" : "forbidden") } : { status: 200, json });
    });
  }
  return { release };
}
