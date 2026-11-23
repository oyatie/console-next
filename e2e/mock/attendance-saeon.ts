// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import { padDigits } from "./saeon-ids";
import { saeonUniverse } from "./saeon";

type S = components["schemas"];

const MONTH = "2026-10";
const DAYS_IN_OCTOBER = 31;

/** Corrected October 2026 calendar: 10-03 National Foundation Day (Sat), 10-05 Substitute Holiday (Mon), 10-09 Hangul Day (Fri). */
export function saeonOctoberDayKind(day: number): S["AttendanceDayKind"] {
  if (day === 3 || day === 9) return "PUBLIC_HOLIDAY";
  if (day === 5) return "SUBSTITUTE_HOLIDAY";
  const weekday = new Date(Date.UTC(2026, 9, day)).getUTCDay();
  if (weekday === 0) return "WEEKLY_HOLIDAY";
  if (weekday === 6) return "REST_DAY";
  return "WORK";
}

export function saeonAttendanceScheduleTree(): S["AttendanceScheduleTree"] {
  const precision = saeonUniverse.entities[0]!;
  const seoul = precision.workplaces[0]!;
  const pyeongtaek = precision.workplaces[1]!;
  const asan = precision.workplaces[2]!;
  const team1Name = pyeongtaek.departments[1]!.split(" › ").at(-1)!;
  const total = saeonUniverse.attendanceMonth.members.length;
  const baseLayer: S["AttendanceLayerSummary"] = {
    layer_id: "00000000-0000-4000-8920-000000000001",
    pattern_id: "00000000-0000-4000-8921-000000000001",
    pattern_name: "09:00–18:00",
    effective_from: "2026-01-01",
    version: 1,
  };
  return {
    date: "2026-10-15",
    people_total: total,
    people_unscheduled: 0,
    holidays_loaded: true,
    nodes: [
      {
        id: precision.id,
        name: precision.name,
        kind: "LEGAL_ENTITY",
        people: total,
        layer: baseLayer,
        unscheduled: 0,
      },
      {
        id: seoul.id,
        parent_id: precision.id,
        name: seoul.name,
        kind: "WORKPLACE",
        people: 8,
        effective: { ...baseLayer, from: "LEGAL_ENTITY" },
        unscheduled: 0,
      },
      {
        id: pyeongtaek.id,
        parent_id: precision.id,
        name: pyeongtaek.name,
        kind: "WORKPLACE",
        people: total,
        effective: { ...baseLayer, from: "LEGAL_ENTITY" },
        unscheduled: 0,
      },
      {
        id: asan.id,
        parent_id: precision.id,
        name: asan.name,
        kind: "WORKPLACE",
        people: 6,
        effective: { ...baseLayer, from: "LEGAL_ENTITY" },
        unscheduled: 0,
      },
      {
        id: "00000000-0000-4000-8210-000000000001",
        parent_id: pyeongtaek.id,
        workplace_id: pyeongtaek.id,
        name: team1Name,
        kind: "DEPARTMENT",
        people: total,
        effective: { ...baseLayer, from: "LEGAL_ENTITY" },
        unscheduled: 0,
      },
    ],
  };
}

function memberId(employeeNumber: string): string {
  return `00000000-0000-4000-8500-${padDigits(Number(employeeNumber), 12)}`;
}

/**
 * October 2026 Team 1 (12 members) month grid with corrected October calendar
 * (`2026-10-03`, `2026-10-05`, `2026-10-09` -> 2 weekday holidays, 20 scheduled work days),
 * unapproved excess counted in `recognised`, and `blocking > 0` keeping close disabled.
 */
export function saeonAttendanceMonthGrid(): S["AttendanceMonthGrid"] {
  const team1Name = saeonUniverse.entities[0]!.workplaces[1]!.departments[1]!.split(" › ").at(-1)!;
  const members = saeonUniverse.attendanceMonth.members;

  const rows: S["AttendanceGridRow"][] = members.map((member, memberIdx) => {
    const id = memberId(member.employeeNumber);
    const annual = new Set(member.annualLeaveDays);
    const half = new Set(member.halfLeaveDays);
    const holidayWork = new Set(member.holidayWorkDays);
    const late = new Set(member.lateDays);
    const absent = new Set(member.absentDays);
    const approvedOt = member.approvedOvertime as Record<string, number>;
    const unapprovedOt = member.unapprovedOvertime as Record<string, number>;
    const missingRecordDay = memberIdx === 5 ? 29 : -1;

    let recognisedTotal = 0;
    let approvedTotal = 0;
    let unrecognisedTotal = 0;
    let notWorkedTotal = 0;
    let blockingTotal = 0;
    let decisionTotal = 0;

    const cells: S["AttendanceGridCell"][] = Array.from({ length: DAYS_IN_OCTOBER }, (_, i) => {
      const day = i + 1;
      const date = `${MONTH}-${String(day).padStart(2, "0")}`;
      const plan_kind = saeonOctoberDayKind(day);
      const dayKey = String(day);
      const appOtMin = Number(approvedOt[dayKey] ?? 0) * 60;
      const unappOtMin = Number(unapprovedOt[dayKey] ?? 0) * 60;

      if (day === missingRecordDay) {
        blockingTotal += 1;
        return {
          date,
          plan_kind,
          recognised: 0,
          unrecognised: 0,
          not_worked: 0,
          marks: ["NO_RECORD"],
        };
      }

      if (plan_kind !== "WORK") {
        if (holidayWork.has(day)) {
          recognisedTotal += 480;
          approvedTotal += 480;
          return {
            date,
            plan_kind,
            entry_id: `00000000-0000-4000-8900-${padDigits(memberIdx * 100 + day, 12)}`,
            entry_kind: "TIMES",
            segments: [{ start: 540, end: 1080 }],
            source: "MANUAL",
            recognised: 480,
            unrecognised: 0,
            not_worked: 0,
            marks: [],
          };
        }
        return {
          date,
          plan_kind,
          recognised: 0,
          unrecognised: 0,
          not_worked: 0,
          marks: [],
        };
      }

      if (absent.has(day)) {
        notWorkedTotal += 480;
        return {
          date,
          plan_kind,
          entry_id: `00000000-0000-4000-8900-${padDigits(memberIdx * 100 + day, 12)}`,
          entry_kind: "ABSENT",
          source: "MANUAL",
          recognised: 0,
          unrecognised: 0,
          not_worked: 480,
          marks: ["ABSENT"],
        };
      }

      if (annual.has(day)) {
        return {
          date,
          plan_kind,
          recognised: 0,
          unrecognised: 0,
          not_worked: 0,
          marks: [],
        };
      }

      if (half.has(day)) {
        recognisedTotal += 240;
        return {
          date,
          plan_kind,
          entry_id: `00000000-0000-4000-8900-${padDigits(memberIdx * 100 + day, 12)}`,
          entry_kind: "TIMES",
          segments: [{ start: 540, end: 780 }],
          source: "MANUAL",
          recognised: 240,
          unrecognised: 0,
          not_worked: 0,
          marks: [],
        };
      }

      if (late.has(day)) {
        recognisedTotal += 460;
        notWorkedTotal += 20;
        return {
          date,
          plan_kind,
          entry_id: `00000000-0000-4000-8900-${padDigits(memberIdx * 100 + day, 12)}`,
          entry_kind: "TIMES",
          segments: [{ start: 560, end: 1080 }],
          source: "MANUAL",
          recognised: 460,
          unrecognised: 0,
          not_worked: 20,
          marks: ["LATE"],
        };
      }

      const regularMin = 480;
      const cellRecognised = regularMin + appOtMin + unappOtMin;
      recognisedTotal += cellRecognised;
      approvedTotal += appOtMin;
      unrecognisedTotal += unappOtMin;
      if (unappOtMin > 0) decisionTotal += 1;

      return {
        date,
        plan_kind,
        entry_id: `00000000-0000-4000-8900-${padDigits(memberIdx * 100 + day, 12)}`,
        entry_kind: "TIMES",
        segments: [{ start: 540, end: 1080 + appOtMin + unappOtMin }],
        source: "SCHEDULE",
        recognised: cellRecognised,
        unrecognised: unappOtMin,
        not_worked: 0,
        marks: unappOtMin > 0 ? ["UNAPPROVED_EXCESS"] : [],
      };
    });

    const gradeLabel = saeonUniverse.grades[member.gradeCode as keyof typeof saeonUniverse.grades];
    const roleLabel = member.roleCode
      ? saeonUniverse.roles[member.roleCode as keyof typeof saeonUniverse.roles]
      : null;

    return {
      employee_id: id,
      employee_number: member.employeeNumber,
      name: member.name,
      unit_name: team1Name,
      position: roleLabel ? `${gradeLabel} · ${roleLabel}` : gradeLabel,
      own: false,
      month_state: { state: "OPEN" },
      totals: {
        recognised: recognisedTotal,
        approved: approvedTotal,
        unrecognised: unrecognisedTotal,
        not_worked: notWorkedTotal,
        blocking: blockingTotal,
        decision: decisionTotal,
        outside_scheduled: approvedTotal + unrecognisedTotal,
      },
      cells,
    };
  });

  const firstCells = rows[0]?.cells ?? [];
  const scheduledDays = firstCells.filter(c => c.plan_kind === "WORK").length;
  const weekdayHolidays = firstCells.filter(c => {
    const dow = new Date(`${c.date}T00:00:00Z`).getUTCDay();
    return dow >= 1 && dow <= 5 && (c.plan_kind === "PUBLIC_HOLIDAY" || c.plan_kind === "SUBSTITUTE_HOLIDAY");
  }).length;
  const summary: S["AttendanceMonthGridSummary"] = {
    scheduled_days: scheduledDays,
    weekday_holidays: weekdayHolidays,
    recognised_minutes: rows.reduce((sum, r) => sum + r.totals.recognised, 0),
    outside_minutes: rows.reduce((sum, r) => sum + (r.totals.outside_scheduled ?? r.totals.approved + r.totals.unrecognised), 0),
    unapproved_minutes: rows.reduce((sum, r) => sum + r.totals.unrecognised, 0),
    blocking_count: rows.reduce((sum, r) => sum + r.totals.blocking, 0),
    decision_count: rows.reduce((sum, r) => sum + r.totals.decision, 0),
    issue_people_count: rows.filter(r => r.totals.blocking + r.totals.decision > 0).length,
    overtime_people_count: rows.filter(r => (r.totals.outside_scheduled ?? r.totals.approved + r.totals.unrecognised) > 0).length,
  };

  return {
    month: MONTH,
    people_total: rows.length,
    next_cursor: null,
    work_pattern_summary: saeonUniverse.hero.workSchedule.split(" · ")[0] ?? null,
    summary,
    rows,
  };
}

export function saeonAttendancePersonMonth(employeeId: string, month = MONTH): S["AttendancePersonMonth"] {
  const grid = saeonAttendanceMonthGrid();
  const row = grid.rows.find(r => r.employee_id === employeeId) ?? grid.rows[0]!;
  const days: S["AttendanceDay"][] = row.cells.map(cell => {
    const isWork = cell.plan_kind === "WORK";
    const hasEntry = Boolean(cell.entry_id && cell.entry_kind);
    const approved = Math.max(0, cell.recognised - (isWork ? 480 : 0) - cell.unrecognised);
    const entry: S["AttendanceEntry"] | undefined = hasEntry
      ? {
          id: cell.entry_id!,
          batch_id: "00000000-0000-4000-8950-000000000001",
          kind: cell.entry_kind as S["AttendanceEntryKind"],
          segments: cell.segments ?? [],
          source: (cell.source as S["AttendanceEntry"]["source"]) ?? "MANUAL",
          evidence_kind: "DEVICE_FILE",
          undone: false,
          created_at: "2026-10-31T18:00:00Z",
          created_by_name: saeonUniverse.adminActor.name,
        }
      : undefined;
    return {
      date: cell.date,
      plan: {
        kind: cell.plan_kind,
        holiday_work: !isWork && cell.recognised > 0,
        ...(isWork ? { shift: { start: 540, end: 1080, breaks: [{ start: 720, end: 780 }] } } : {}),
      },
      entry,
      marks: cell.marks ?? [],
      recognition: {
        recorded: cell.recognised,
        recognised: cell.recognised,
        regular: Math.min(cell.recognised, isWork ? 480 : 0),
        approved,
        outside_scheduled: approved + cell.unrecognised,
        excess_open: cell.unrecognised,
        early_unrecognised: 0,
        late_unrecognised: cell.unrecognised,
        late_in: cell.marks?.includes("LATE") ? cell.not_worked : 0,
        early_out: 0,
        away: 0,
        approval_unused: 0,
      },
    };
  });

  return {
    employee_id: row.employee_id,
    employee_number: row.employee_number,
    name: row.name,
    month,
    provisional: true,
    month_state: row.month_state,
    days,
    history: days.flatMap(d => (d.entry ? [{ date: d.date, entry: d.entry }] : [])),
    totals: row.totals,
  };
}
