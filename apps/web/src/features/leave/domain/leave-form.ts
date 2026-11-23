// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { addDays, daysBetween, isDate, shiftMonth, utc } from "../../../ui/date/days";

type AttendanceScheduleDay = components["schemas"]["AttendanceScheduleDay"];
type LeaveCreateBody = components["schemas"]["LeaveCreateRequest"];

export type LeaveOptionKind = "annual" | "half_am" | "half_pm";
export type LeaveSpanMode = "one" | "multi";
type LeaveDateProblem = "end_before_start" | "range_max";

const MAX_RANGE_DAYS = 366;
const NON_WORKING_DAY_KINDS: ReadonlySet<AttendanceScheduleDay["kind"]> = new Set([
  "WEEKLY_HOLIDAY",
  "REST_DAY",
  "PUBLIC_HOLIDAY",
  "SUBSTITUTE_HOLIDAY",
  "ELECTION_DAY",
  "LABOR_DAY",
  "CONTRACTUAL_HOLIDAY",
]);

/** Parses a 6-decimal backend leave unit string without coercing null or blank strings to zero. */
export function parseLeaveUnits(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Formats leave days concisely (`15`, `5.5`, `8.5`). */
export function formatLeaveDays(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** Validates start and end dates against the backend `<= 366` calendar-day limit. */
export function validateLeaveDates(startDate: string, endDate: string): LeaveDateProblem | null {
  if (!isDate(startDate) || !isDate(endDate)) return null;
  if (endDate < startDate) return "end_before_start";
  const spanDays = daysBetween(startDate, endDate) + 1;
  if (spanDays > MAX_RANGE_DAYS) return "range_max";
  return null;
}

/** Lists deduplicated `YYYY-MM` months covering `[startDate .. endDate]` (up to the 13 months of a 366-day span). */
export function listScheduleMonths(startDate: string, endDate: string): string[] {
  if (!isDate(startDate) || !isDate(endDate) || endDate < startDate) return [];
  if (daysBetween(startDate, endDate) + 1 > MAX_RANGE_DAYS) return [];
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  const months: string[] = [];
  let cur = startMonth;
  while (cur <= endMonth && months.length < 13) {
    months.push(cur);
    cur = shiftMonth(cur, 1);
  }
  return months;
}

/** Collects loaded schedule days and loaded month keys across a multi-month query list. */
export function collectLoadedSchedules(
  months: readonly string[],
  results: ReadonlyArray<{ data?: { days: readonly AttendanceScheduleDay[] } }>,
): { scheduleByDate: Map<string, AttendanceScheduleDay["kind"]>; loadedMonths: Set<string> } {
  const scheduleByDate = new Map<string, AttendanceScheduleDay["kind"]>();
  const loadedMonths = new Set<string>();
  for (let i = 0; i < months.length; i++) {
    const data = results[i]?.data;
    if (!data) continue;
    loadedMonths.add(months[i]!);
    for (const day of data.days) scheduleByDate.set(day.date, day.kind);
  }
  return { scheduleByDate, loadedMonths };
}

/**
 * Estimates requested leave days from the user's selected dates and optional self-service work schedule.
 * Half-day requests always equal `0.5`; multi-day annual requests skip explicit holidays/rest days in loaded months
 * and exclude Saturday/Sunday for any covered month whose schedule failed to load.
 */
export function computeRequestedDays({
  kind,
  startDate,
  endDate,
  scheduleByDate,
  loadedMonths,
}: {
  kind: LeaveOptionKind;
  startDate: string;
  endDate: string;
  scheduleByDate?: ReadonlyMap<string, AttendanceScheduleDay["kind"]>;
  loadedMonths?: ReadonlySet<string>;
}): number {
  if (kind === "half_am" || kind === "half_pm") return 0.5;
  if (!isDate(startDate) || !isDate(endDate) || endDate < startDate) return 0;
  const calendarDays = daysBetween(startDate, endDate) + 1;
  if (calendarDays > MAX_RANGE_DAYS) return 0;
  if (!loadedMonths && (!scheduleByDate || scheduleByDate.size === 0)) return calendarDays;
  let count = 0;
  for (let i = 0; i < calendarDays; i++) {
    const date = addDays(startDate, i);
    const monthLoaded = loadedMonths ? loadedMonths.has(date.slice(0, 7)) : true;
    if (monthLoaded) {
      const dayKind = scheduleByDate?.get(date);
      if (!dayKind || !NON_WORKING_DAY_KINDS.has(dayKind)) {
        count += 1;
      }
    } else {
      const dow = new Date(utc(date)).getUTCDay();
      if (dow !== 0 && dow !== 6) {
        count += 1;
      }
    }
  }
  return count;
}

/** Builds a `LeaveCreateRequest` payload conforming strictly to OpenAPI (never sending `reason`). */
export function buildLeaveCreatePayload({
  idempotencyKey,
  kind,
  startDate,
  endDate,
}: {
  idempotencyKey: string;
  kind: LeaveOptionKind;
  startDate: string;
  endDate: string;
}): LeaveCreateBody {
  if (kind === "half_am" || kind === "half_pm") {
    return {
      idempotency_key: idempotencyKey,
      leave_type: "half_day",
      partial_day_period: kind === "half_am" ? "am" : "pm",
      start_date: startDate,
      end_date: startDate,
    };
  }
  return {
    idempotency_key: idempotencyKey,
    leave_type: "annual",
    start_date: startDate,
    end_date: endDate,
  };
}
