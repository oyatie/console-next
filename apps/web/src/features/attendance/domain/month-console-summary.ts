// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { ATTENDANCE_MARK } from "../../../lib/labels";

type GridRow = components["schemas"]["AttendanceGridRow"];
type Mark = components["schemas"]["AttendanceMark"];

export type MonthFilter = "all" | "issues" | "overtime";

export type OpenIssueRow = {
  key: string;
  employeeId: string;
  employeeNumber: string;
  name: string;
  own: boolean;
  date: string;
  mark: Mark;
  tone: "danger" | "warn" | "info";
  recognised: number;
  unrecognised: number;
  notWorked: number;
};

const HOLIDAY_KINDS = new Set([
  "PUBLIC_HOLIDAY",
  "SUBSTITUTE_HOLIDAY",
  "ELECTION_DAY",
  "LABOR_DAY",
  "CONTRACTUAL_HOLIDAY",
]);

const SEVERITY_RANK: Record<"danger" | "warn" | "info", number> = {
  danger: 0,
  warn: 1,
  info: 2,
};

function isWeekday(isoDate: string): boolean {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function primaryMark(marks: readonly Mark[]): { mark: Mark; tone: "danger" | "warn" | "info" } {
  let best = marks[0]!;
  let bestTone: "danger" | "warn" | "info" =
    (ATTENDANCE_MARK.tone?.[best] as "danger" | "warn" | "info" | undefined) ?? "info";
  for (const m of marks.slice(1)) {
    const tone = (ATTENDANCE_MARK.tone?.[m] as "danger" | "warn" | "info" | undefined) ?? "info";
    if (SEVERITY_RANK[tone] < SEVERITY_RANK[bestTone]) {
      best = m;
      bestTone = tone;
    }
  }
  return { mark: best, tone: bestTone };
}

export function summarizeMonth(rows: readonly GridRow[], total: number, days: readonly string[]) {
  const firstCells = rows[0]?.cells ?? [];
  const scheduledDays = firstCells.length
    ? firstCells.filter(c => c.plan_kind === "WORK").length
    : days.filter(isWeekday).length;
  const weekdayHolidays = firstCells.filter(c => HOLIDAY_KINDS.has(c.plan_kind) && isWeekday(c.date)).length;

  let recognisedMinutes = 0;
  let outsideMinutes = 0;
  let unapprovedMinutes = 0;
  let blockingCount = 0;
  let decisionCount = 0;
  let issuePeopleCount = 0;
  let overtimePeopleCount = 0;

  for (const r of rows) {
    recognisedMinutes += r.totals.recognised;
    const outside = r.totals.outside_scheduled ?? r.totals.approved + r.totals.unrecognised;
    outsideMinutes += outside;
    unapprovedMinutes += r.totals.unrecognised;
    blockingCount += r.totals.blocking;
    decisionCount += r.totals.decision;
    if (r.totals.blocking + r.totals.decision > 0 || r.cells.some(c => (c.marks?.length ?? 0) > 0)) {
      issuePeopleCount += 1;
    }
    if (outside > 0) overtimePeopleCount += 1;
  }

  return {
    total,
    scheduledDays,
    weekdayHolidays,
    recognisedMinutes,
    outsideMinutes,
    unapprovedMinutes,
    blockingCount,
    decisionCount,
    issuePeopleCount,
    overtimePeopleCount,
  };
}

export function filterMonthRows(rows: readonly GridRow[], filter: MonthFilter): readonly GridRow[] {
  if (filter === "issues") {
    return rows.filter(r => r.totals.blocking + r.totals.decision > 0 || r.cells.some(c => (c.marks?.length ?? 0) > 0));
  }
  if (filter === "overtime") {
    return rows.filter(r => (r.totals.outside_scheduled ?? r.totals.approved + r.totals.unrecognised) > 0);
  }
  return rows;
}

export function extractOpenIssues(rows: readonly GridRow[]): OpenIssueRow[] {
  const items: OpenIssueRow[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      const marks = cell.marks;
      if (!marks || marks.length === 0) continue;
      const { mark, tone } = primaryMark(marks);
      items.push({
        key: `${row.employee_id}|${cell.date}`,
        employeeId: row.employee_id,
        employeeNumber: row.employee_number ?? "",
        name: row.name,
        own: row.own,
        date: cell.date,
        mark,
        tone,
        recognised: cell.recognised,
        unrecognised: cell.unrecognised,
        notWorked: cell.not_worked,
      });
    }
  }
  items.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.tone] - SEVERITY_RANK[b.tone];
    if (rankDiff !== 0) return rankDiff;
    const dateDiff = a.date.localeCompare(b.date);
    if (dateDiff !== 0) return dateDiff;
    return a.employeeNumber.localeCompare(b.employeeNumber);
  });
  return items;
}

export function summarizeDailyFooter(rows: readonly GridRow[], dayCount: number) {
  const workedCount = Array.from({ length: dayCount }, () => 0);
  const approvedOtMinutes = Array.from({ length: dayCount }, () => 0);
  let recognisedMinutes = 0;
  let outsideMinutes = 0;
  let unapprovedMinutes = 0;
  let issueCount = 0;

  for (const row of rows) {
    recognisedMinutes += row.totals.recognised;
    outsideMinutes += row.totals.outside_scheduled ?? row.totals.approved + row.totals.unrecognised;
    unapprovedMinutes += row.totals.unrecognised;
    for (let c = 0; c < dayCount; c += 1) {
      const cell = row.cells[c];
      if (!cell) continue;
      if (cell.recognised > 0) workedCount[c]! += 1;
      if ((cell.marks?.length ?? 0) > 0) issueCount += 1;
      const isHolidayOrRest = cell.plan_kind !== "WORK" && cell.plan_kind !== "NO_SCHEDULE";
      const approved = isHolidayOrRest
        ? Math.max(0, cell.recognised - cell.unrecognised)
        : Math.max(0, cell.recognised - 480 - cell.unrecognised);
      approvedOtMinutes[c]! += approved;
    }
  }

  return {
    workedCount,
    approvedOtMinutes,
    recognisedMinutes,
    outsideMinutes,
    unapprovedMinutes,
    issueCount,
  };
}
