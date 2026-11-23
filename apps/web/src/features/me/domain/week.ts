// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { addDays, isDate, nextMonday } from "../../../ui/date/days";

type S = components["schemas"];

/** Snaps any `YYYY-MM-DD` date to its ISO week Monday (YYYY-MM-DD). */
export function isoMondayOf(date: string): string {
  if (!isDate(date)) return date;
  return addDays(nextMonday(date), -7);
}

/** Shifts an ISO date by `deltaWeeks` weeks and snaps to ISO Monday. */
export function shiftIsoWeek(date: string, deltaWeeks: number): string {
  return isoMondayOf(addDays(isoMondayOf(date), deltaWeeks * 7));
}

/** Counts scheduled working days in a self-service attendance calendar. */
export function countScheduledWorkDays(calendar: S["AttendanceScheduleCalendar"] | undefined): number {
  if (!calendar) return 0;
  return calendar.days.filter(d => d.kind === "WORK").length;
}

/** Counts open exceptions in a page of own attendance exceptions. */
export function countOpenOwnExceptions(items: readonly S["OwnAttendanceException"][] | undefined): number {
  if (!items) return 0;
  return items.filter(item => item.status === "OPEN").length;
}

/** Computes the next natural punch kind from the most recent recorded attendance state. */
export function nextPunchKind(records: readonly S["EmployeeAttendanceRecord"][] | undefined): S["AttendanceRecordKind"] {
  const latest = records?.[0];
  if (!latest) return "CLOCK_IN";
  return latest.state_after === "OFF_DUTY" ? "CLOCK_IN" : "CLOCK_OUT";
}
