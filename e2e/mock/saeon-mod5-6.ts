// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { shot, withFullPage } from "../shots";
import { id } from "./fixtures";
import { saeonUniverse, saeonHeroUser, saeonFilterEmployees, saeonEmployeeFacets } from "./saeon";
import { saeonAttendanceMonthGrid, saeonOctoberDayKind } from "./attendance-saeon";

type S = components["schemas"];

export async function enableConsole(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ({ expKey, themeValue }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", "ko");
    },
    { expKey: EXPERIENCE_KEY, themeValue: theme },
  );
}

export async function captureBuiltConsoleShot(page: Page, width: 1440 | 390, name: string, theme: "light" | "dark") {
  if (!process.env.STRUCT_SHOTS) return;
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
  await withFullPage(page, () => shot(page, `${name}--${width}-${theme}`));
}

export function saeonTeamAccess(opts?: { tenantWide?: boolean; concurrent?: boolean; canManage?: boolean }): S["AccessEffective"] {
  const precision = saeonUniverse.entities[0]!;
  const pyeongtaek = precision.workplaces[1]!;
  const ulsan = saeonUniverse.entities[0]!.workplaces[0]!;
  const team1Name = pyeongtaek.departments[1]!.split(" › ").at(-1)!;
  const entries: S["AccessEffectiveEntry"][] = opts?.tenantWide
    ? [
        {
          grant_id: "00000000-0000-4000-8600-000000000001",
          role_id: "00000000-0000-4000-8601-000000000001",
          role_name_ko: saeonUniverse.adminActor.unit,
          domain: "hr_basic",
          level: opts.canManage ? "edit" : "view",
          enforcement: "ENFORCED",
          valid_from: "2026-01-01T00:00:00Z",
          scope: { kind: "TENANT", include_descendants: true },
          caveats: [],
        },
      ]
    : [
        {
          grant_id: "00000000-0000-4000-8600-000000000010",
          role_id: "00000000-0000-4000-8601-000000000010",
          role_name_ko: `${team1Name} ${saeonUniverse.roles.TEAM_LEAD}`,
          domain: "hr_basic",
          level: opts?.canManage ? "edit" : "view",
          enforcement: "ENFORCED",
          valid_from: "2026-01-01T00:00:00Z",
          scope: { kind: "DEPARTMENT", node_id: "00000000-0000-4000-8210-000000000001", node_name: team1Name, include_descendants: true },
          caveats: [],
        },
        ...(opts?.concurrent
          ? [
              {
                grant_id: "00000000-0000-4000-8600-000000000011",
                role_id: "00000000-0000-4000-8601-000000000011",
                role_name_ko: `${ulsan.name} ${saeonUniverse.roles.DEPT_HEAD}`,
                domain: "hr_basic",
                level: "view" as const,
                enforcement: "ENFORCED" as const,
                valid_from: "2026-01-01T00:00:00Z",
                scope: { kind: "WORKPLACE" as const, node_id: ulsan.id, node_name: ulsan.name, include_descendants: true },
                caveats: [],
              },
            ]
          : []),
      ];
  return {
    account_id: saeonHeroUser().id,
    is_ops: false,
    phase: "OPERATING",
    as_of: "2026-11-16T09:00:00Z",
    entries,
    decisions: {},
  };
}

export function saeonTeamEmployees(): S["EmployeePage"] {
  const page = saeonFilterEmployees(new URLSearchParams("limit=12"));
  const precision = saeonUniverse.entities[0]!;
  const pyeongtaek = precision.workplaces[1]!;
  const ulsan = precision.workplaces[0]!;
  const team1Name = pyeongtaek.departments[1]!.split(" › ").at(-1)!;
  const secondaryUnit = ulsan.departments[0]!;
  const items: S["Employee"][] = page.items.slice(0, 8).map((emp, idx) => ({
    ...emp,
    org_unit: idx < 5 ? team1Name : secondaryUnit,
    org_unit_id: idx < 5 ? "00000000-0000-4000-8210-000000000001" : "00000000-0000-4000-8210-000000000002",
    workplace_id: idx < 5 ? pyeongtaek.id : ulsan.id,
    status: idx === 2 ? "ON_LEAVE" : "ACTIVE",
    next_event:
      idx === 1
        ? { id: id(6100 + idx), event_type: "CONTRACT_RENEWAL" as const, effective_date: "2026-11-24" }
        : null,
  }));
  return { ...page, items, total: items.length, next_cursor: null };
}

export function saeonTeamFacets(): S["EmployeeFacets"] {
  const base = saeonEmployeeFacets();
  return {
    ...base,
    total: 8,
    status: [
      { value: "ACTIVE", count: 7 },
      { value: "ON_LEAVE", count: 1 },
    ],
    review: { ...base.review, contract_ending_before: 1 },
  };
}

export function saeonTeamLeaveQueue(employees: readonly S["Employee"][]): { items: S["LeaveRequestV2View"][]; next_cursor: string | null } {
  const first = employees[0];
  if (!first) return { items: [], next_cursor: null };
  return {
    items: [
      {
        id: "00000000-0000-4000-8700-000000000001",
        branch_id: first.workplace_id ?? "00000000-0000-4000-8200-000000000102",
        requester_user_id: saeonHeroUser().id,
        subject_employee_id: first.id,
        leave_type: "annual",
        days: 2,
        charge_units: "2",
        charge_state: "resolved",
        charge_review_reasons: [],
        request_version: 1,
        charge_version: 1,
        start_date: "2026-11-25",
        end_date: "2026-11-26",
        reason: t("leave.type.annual"),
        status: "pending",
        decided_by: null,
        decided_at: null,
        created_at: "2026-11-15T01:00:00Z",
      },
    ],
    next_cursor: null,
  };
}

export function saeonOwnWeek52(available = true): S["OwnAttendanceWeek52Response"] {
  if (!available) return { status: "not_available" };
  return {
    status: "available",
    projection: {
      week_start: "2026-11-16",
      current_hours: 34.5,
      projected_hours: 42.0,
      tone: "OK",
      acknowledged_at: null,
    },
  };
}

export function saeonOwnAttendanceRecords(): S["EmployeeAttendanceRecord"][] {
  const hero = saeonHeroUser();
  return [
    {
      id: "00000000-0000-4000-8800-000000000001",
      employee_id: hero.employee_id!,
      employee_display_name: hero.employee_name!,
      kind: "CLOCK_IN",
      occurred_at: "2026-11-16T00:00:00Z",
      work_date: "2026-11-16",
      state_after: "CLOCKED_IN",
      note: saeonUniverse.entities[0]!.workplaces[1]!.name,
      payroll_material_ref_id: "00000000-0000-4000-8850-000000000001",
      payroll_link_status: "LINKED",
      duplicate: false,
    },
  ];
}

export function saeonOwnExceptions(): S["OwnAttendanceException"][] {
  return [
    {
      id: "00000000-0000-4000-8810-000000000001",
      code: "EXC-2026-1112",
      kind: "LATE",
      status: "OPEN",
      work_date: "2026-11-12",
      occurred_at: "2026-11-12T00:18:00Z",
      detail: `${t("attendance.exception.LATE")} (+18m)`,
      evidence: [],
      created_at: "2026-11-12T00:20:00Z",
    },
  ];
}

export function saeonAttendanceDayBoard(): S["AttendanceDayBoard"] {
  const grid = saeonAttendanceMonthGrid();
  const pyeongtaek = saeonUniverse.entities[0]!.workplaces[1]!;
  const team1Name = pyeongtaek.departments[1]!.split(" › ").at(-1)!;
  const boardRows: S["AttendanceBoardRow"][] = grid.rows.slice(0, 6).map((row, idx) => {
    const cell = row.cells.find(c => c.date === "2026-10-15") ?? row.cells[14]!;
    return {
      employee_id: row.employee_id,
      employee_number: row.employee_number,
      name: row.name,
      own: false,
      month_state: row.month_state,
      day: {
        date: "2026-10-15",
        plan: { kind: cell.plan_kind, holiday_work: false, shift: { start: 540, end: 1080, breaks: [{ start: 720, end: 780 }] } },
        ...(idx === 1
          ? {}
          : {
              entry: {
                id: id(6500 + idx),
                batch_id: id(6600 + idx),
                kind: "TIMES" as const,
                source: idx === 0 ? ("MANUAL" as const) : ("IMPORT" as const),
                evidence_kind: "TIME_RECORD",
                segments: [{ start: idx === 0 ? 555 : 540, end: 1080 }],
                undone: false,
                created_at: "2026-10-15T09:00:00Z",
                created_by_name: saeonUniverse.adminActor.name,
              },
            }),
        marks: idx === 0 ? ["LATE"] : idx === 1 ? ["NO_RECORD"] : [],
        recognition: {
          recorded: idx === 1 ? 0 : 480,
          recognised: idx === 1 ? 0 : 480,
          regular: idx === 1 ? 0 : 480,
          approved: 0,
          early_unrecognised: 0,
          late_unrecognised: 0,
          late_in: idx === 0 ? 15 : 0,
          early_out: 0,
          away: 0,
          approval_unused: 0,
        },
      },
    };
  });
  return {
    date: "2026-10-15",
    judged: true,
    marks: { blocking: 1, decision: 0, info: 1 },
    ledger: {
      people: boardRows.length,
      no_schedule: 0,
      rest: 0,
      normal: boardRows.length - 2,
      no_record: 1,
      pending: 0,
      missing_out: 0,
      absent: 0,
      outside: 0,
      trip: 0,
      late_or_early: 1,
    },
    groups: [
      {
        workplace_id: pyeongtaek.id,
        unit_id: "00000000-0000-4000-8210-000000000001",
        name: `${pyeongtaek.name} · ${team1Name}`,
        people: boardRows.length,
        normal: boardRows.length - 2,
        no_schedule: 0,
        marks: { blocking: 1, decision: 0, info: 1 },
        hidden: 0,
        rows: boardRows,
      },
    ],
  };
}

export function saeonAttendanceWeek52Board(): S["AttendanceWeek52Board"] {
  const grid = saeonAttendanceMonthGrid();
  const team1Name = saeonUniverse.entities[0]!.workplaces[1]!.departments[1]!.split(" › ").at(-1)!;
  return {
    week_start: "2026-10-12",
    items: grid.rows.slice(0, 6).map((row, idx) => ({
      employee_id: row.employee_id,
      name: row.name,
      team: team1Name,
      week_start: "2026-10-12",
      current_hours: idx === 0 ? 50.5 : idx === 1 ? 45.0 : 39.5,
      projected_hours: idx === 0 ? 54.0 : idx === 1 ? 49.0 : 40.0,
      recognized_hours: idx === 0 ? 48.0 : 40.0,
      overtime_hours: idx === 0 ? 10.5 : idx === 1 ? 5.0 : 0,
      tone: idx === 0 ? "DANGER" : idx === 1 ? "WARN" : idx === 5 ? "UNKNOWN" : "OK",
      acked: idx > 1,
      acked_at: idx > 1 ? "2026-10-13T09:00:00Z" : null,
    })),
  };
}

export function saeonAttendanceExceptionsPage(): S["AttendanceExceptionPage"] {
  const grid = saeonAttendanceMonthGrid();
  const pyeongtaek = saeonUniverse.entities[0]!.workplaces[1]!;
  const team1Name = pyeongtaek.departments[1]!.split(" › ").at(-1)!;
  const r0 = grid.rows[0]!;
  const r1 = grid.rows[1]!;
  return {
    items: [
      {
        id: "00000000-0000-4000-8900-000000000001",
        code: "EXC-1001",
        kind: "LATE",
        status: "OPEN",
        employee_id: r0.employee_id,
        employee_name: r0.name,
        team: team1Name,
        branch_id: pyeongtaek.id,
        work_date: "2026-10-14",
        occurred_at: "2026-10-14T00:15:00Z",
        detail: `${t("attendance.exception.LATE")} (+15m)`,
        evidence: [{ name: "gate-1014.csv", size: "12 KB" }],
        links: [{ kind: "day", label: t("attendance.tab.day"), ref: "2026-10-14" }],
        created_at: "2026-10-14T01:00:00Z",
      },
      {
        id: "00000000-0000-4000-8900-000000000002",
        code: "EXC-1002",
        kind: "UNAPPROVED_OVERTIME",
        status: "OPEN",
        employee_id: r1.employee_id,
        employee_name: r1.name,
        team: team1Name,
        branch_id: pyeongtaek.id,
        work_date: "2026-10-15",
        occurred_at: "2026-10-15T10:30:00Z",
        detail: `${t("attendance.exception.UNAPPROVED_OVERTIME")} (+90m)`,
        evidence: [{ name: "gate-1015.log", size: "8 KB" }],
        links: [],
        created_at: "2026-10-15T11:00:00Z",
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  };
}

export function saeonAttendanceCloses(): { items: S["AttendanceMonthCloseItem"][] } {
  const seoul = saeonUniverse.entities[0]!.workplaces[0]!;
  const pyeongtaek = saeonUniverse.entities[0]!.workplaces[1]!;
  const asan = saeonUniverse.entities[0]!.workplaces[2]!;
  return {
    items: [
      {
        branch_scope: pyeongtaek.id,
        closed: false,
        open_exceptions: 2,
        pending_leave: 1,
      },
      {
        branch_scope: seoul.id,
        closed: true,
        open_exceptions: 0,
        pending_leave: 0,
        close: {
          id: "00000000-0000-4000-8910-000000000001",
          month: "2026-10",
          branch_scope: seoul.id,
          checks: [
            { key: "exceptions_cleared", ok: true, note: t("me.attendance.exceptions.empty") },
            { key: "leave_decisions_settled", ok: true, note: t("attendance.close.closed") },
          ],
          attested_by: saeonHeroUser().id,
          attested_at: "2026-10-31T08:30:00Z",
          closed_at: "2026-10-31T09:00:00Z",
          amendments: [],
        },
      },
      {
        branch_scope: asan.id,
        closed: false,
        open_exceptions: 0,
        pending_leave: 1,
      },
    ],
  };
}

const SAEON_DAY_SHIFT = { start: 540, end: 1080, breaks: [{ start: 720, end: 780 }] };

export function saeonAttendanceScheduleCalendar(
  scopeKind: S["AttendanceScopeKind"] = "WORKPLACE",
  scopeId?: string,
  month = "2026-10",
): S["AttendanceScheduleCalendar"] {
  const precision = saeonUniverse.entities[0]!;
  const pyeongtaek = precision.workplaces[1]!;
  const resolvedId = scopeId ?? pyeongtaek.id;
  const resolvedName = resolvedId === precision.id ? precision.name : pyeongtaek.name;
  const layer: S["AttendanceLayerSummary"] = {
    layer_id: "00000000-0000-4000-8920-000000000001",
    pattern_id: "00000000-0000-4000-8921-000000000001",
    pattern_name: `${t("attendanceSchedule.assign.pattern")} (09:00–18:00)`,
    effective_from: "2026-01-01",
    version: 1,
  };
  const holidayNames: Record<number, string> = { 3: t("attendanceSchedule.monthHolidays.title"), 5: t("attendanceSchedule.monthHolidays.title"), 9: t("attendanceSchedule.monthHolidays.title") };
  const days: S["AttendanceScheduleDay"][] = Array.from({ length: 31 }, (_, i) => {
    const day = i + 1;
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const kind = saeonOctoberDayKind(day);
    return {
      date,
      kind,
      ...(kind === "WORK" ? { shift: SAEON_DAY_SHIFT } : {}),
      ...(holidayNames[day] ? { holiday_name: holidayNames[day] } : {}),
      decided_by: "LEGAL_ENTITY",
      layer_id: layer.layer_id,
    };
  });
  return {
    scope_kind: scopeKind,
    scope_id: resolvedId,
    scope_name: resolvedName,
    month,
    stack: [
      ...(scopeKind !== "LEGAL_ENTITY"
        ? [{ level: scopeKind, scope_id: resolvedId, scope_name: resolvedName, wins: false }]
        : []),
      { level: "LEGAL_ENTITY", scope_id: precision.id, scope_name: precision.name, layer, wins: true },
    ],
    upcoming: [],
    holidays_loaded: true,
    days,
  };
}

export function saeonAttendanceScheduleLayers(): { items: S["AttendanceScheduleLayer"][] } {
  const precision = saeonUniverse.entities[0]!;
  return {
    items: [
      {
        id: "00000000-0000-4000-8920-000000000001",
        scope_kind: "LEGAL_ENTITY",
        scope_id: precision.id,
        scope_name: precision.name,
        pattern_id: "00000000-0000-4000-8921-000000000001",
        pattern_name: `${t("attendanceSchedule.assign.pattern")} (09:00–18:00)`,
        effective_from: "2026-01-01",
        reason: "STANDARD",
        state: "IN_EFFECT",
        version: 1,
        created_at: "2026-01-01T00:00:00Z",
        created_by_name: saeonUniverse.adminActor.name,
      },
    ],
  };
}
