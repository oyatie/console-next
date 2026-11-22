// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { ReadReference } from "../../../lib/react/read-reference";
import { myAccessQuery } from "../../../reference/authz/api";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { addDays } from "../../../ui/date/days";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow, type StatRowItem } from "../../../ui/key-value/key-value";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { Receipt } from "../../../ui/receipt/receipt";
import { RecordSection } from "../../../ui/record/record-section";
import { Table, type Column } from "../../../ui/table";
import { useQuery } from "@tanstack/react-query";
import {
  createMyAttendanceRecord,
  isForbiddenError,
  type AttendanceRecordKind,
  type OwnAttendanceRecord,
  type OwnException,
  type OwnScheduleCalendar,
  type OwnWeek52,
} from "../api";
import { countOpenOwnExceptions, countScheduledWorkDays, nextPunchKind } from "../domain/week";
import s from "./me.module.css";

const WEEK_TONE = { OK: "ok", WARN: "warn", DANGER: "danger", UNKNOWN: "muted" } as const;
const EXC_TONE = { OPEN: "warn", RESOLVED: "ok" } as const;
const STATE_TONE = {
  CLOCKED_IN: "ok",
  OUT_FOR_WORK: "info",
  BUSINESS_TRIP: "info",
  OFF_DUTY: "neutral",
} as const;

function padTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatShift(day: OwnScheduleCalendar["days"][number]): string {
  if (!day.shift) return "—";
  return `${padTime(day.shift.start)}–${padTime(day.shift.end)}`;
}

export function MeAttendanceStrip({
  week52,
  schedule,
  exceptions,
}: {
  week52: OwnWeek52 | undefined;
  schedule: UseQueryResult<OwnScheduleCalendar>;
  exceptions: readonly OwnException[] | undefined;
}) {
  const available = week52?.status === "available" ? week52.projection : undefined;
  const scheduledDays = schedule.isSuccess ? countScheduledWorkDays(schedule.data) : undefined;
  const openCount = countOpenOwnExceptions(exceptions);
  const items: StatRowItem[] = [
    {
      key: "current",
      label: t("me.attendance.week52.current"),
      value: available
        ? t("me.attendance.week52.hours", { hours: available.current_hours })
        : t("me.attendance.week52.notAvailable"),
      tone: available ? WEEK_TONE[available.tone] : "muted",
    },
    {
      key: "projected",
      label: t("me.attendance.week52.projected"),
      value: available
        ? t("me.attendance.week52.hours", { hours: available.projected_hours })
        : t("me.attendance.week52.notAvailable"),
      tone: available ? WEEK_TONE[available.tone] : "muted",
    },
    {
      key: "scheduled",
      label: t("me.attendance.schedule.days"),
      value: schedule.isError && isForbiddenError(schedule.error)
        ? t("me.attendance.schedule.unplaced")
        : scheduledDays !== undefined
          ? t("me.attendance.schedule.daysValue", { count: scheduledDays })
          : "—",
    },
    {
      key: "exceptions",
      label: t("me.attendance.exceptions.openCount"),
      value: t("attendance.count", { count: openCount }),
      tone: openCount > 0 ? "warn" : undefined,
    },
  ];
  return <StatRow label={t("me.attendance.stripLabel")} items={items} />;
}

export function MeAttendanceSections({
  schedule,
  records,
  exceptions,
  recordsQuery,
  exceptionsQuery,
  compactScheduleWeekStart,
  fullScheduleLink,
}: {
  schedule: UseQueryResult<OwnScheduleCalendar>;
  records: readonly OwnAttendanceRecord[];
  exceptions: readonly OwnException[];
  recordsQuery?: UseQueryResult<{ items: OwnAttendanceRecord[] }>;
  exceptionsQuery?: UseQueryResult<{ items: OwnException[] }>;
  compactScheduleWeekStart?: string;
  fullScheduleLink?: boolean;
}) {
  const access = useQuery(myAccessQuery);
  const [receipt, setReceipt] = useState<string | null>(null);
  const canClock = Boolean(
    access.data &&
      (access.data.is_ops ||
        access.data.entries.some(
          entry =>
            entry.domain === "attendance" &&
            entry.enforcement === "ENFORCED" &&
            (entry.level === "edit" || entry.level === "approve"),
        )),
  );
  const nextKind = nextPunchKind(records);
  const punch = useCommand<AttendanceRecordKind, OwnAttendanceRecord>({
    run: (kind, idempotency_key) => createMyAttendanceRecord({ kind, idempotency_key }),
    invalidates: ["/api/v1/hr/attendance-records/me", "/api/v1/attendance/me/week52"],
    onSuccess: created => {
      setReceipt(t("me.attendance.records.recorded", { kind: t(`me.attendance.recordKind.${created.kind}`) }));
    },
  });

  const recordCols: LongColumn<OwnAttendanceRecord>[] = [
    { id: "date", header: t("me.attendance.records.col.date"), type: "date", card: "fact", rowHeader: true, cell: r => <bdi className="num">{fmtDate(r.work_date)}</bdi> },
    { id: "kind", header: t("me.attendance.records.col.kind"), card: "title", cell: r => t(`me.attendance.recordKind.${r.kind}`) },
    { id: "time", header: t("me.attendance.records.col.time"), card: "fact", cell: r => <time className="num" dateTime={r.occurred_at}>{fmtDateTime(r.occurred_at)}</time> },
    { id: "state", header: t("me.attendance.records.col.state"), card: "status", cell: r => <Chip tone={STATE_TONE[r.state_after]}>{t(`me.attendance.recordState.${r.state_after}`)}</Chip> },
    { id: "note", header: t("me.attendance.records.col.note"), card: "omit", cell: r => r.note ?? "—" },
  ];

  const scheduleCols: Column<OwnScheduleCalendar["days"][number]>[] = [
    { header: t("me.attendance.schedule.col.date"), type: "date", card: "fact", rowHeader: true, cell: d => <bdi className="num">{fmtDate(d.date)}</bdi> },
    {
      header: t("me.attendance.schedule.col.kind"),
      card: "title",
      cell: d => d.holiday_name ? `${t(`attendance.dayKind.${d.kind}`)} · ${d.holiday_name}` : t(`attendance.dayKind.${d.kind}`),
    },
    {
      header: t("me.attendance.schedule.col.shift"),
      card: "action",
      cell: d =>
        d.shift ? (
          <bdi className="num">{formatShift(d)}</bdi>
        ) : (
          <bdi className={s.desktopDash} aria-hidden="true">—</bdi>
        ),
    },
    { header: t("me.attendance.schedule.col.note"), card: "omit", cell: d => d.holiday_name ?? "—" },
  ];

  const exceptionCols: LongColumn<OwnException>[] = [
    { id: "date", header: t("me.attendance.exceptions.col.date"), type: "date", card: "fact", rowHeader: true, cell: e => <bdi className="num">{fmtDate(e.work_date)}</bdi> },
    { id: "kind", header: t("me.attendance.exceptions.col.kind"), card: "title", cell: e => t(`attendance.exception.${e.kind}`) },
    { id: "state", header: t("me.attendance.exceptions.col.state"), card: "status", cell: e => <Chip tone={EXC_TONE[e.status]}>{t(`attendance.exception.${e.status}`)}</Chip> },
    { id: "detail", header: t("me.attendance.exceptions.col.detail"), card: "fact", cell: e => e.detail },
  ];

  const compactWeekEnd = compactScheduleWeekStart ? addDays(compactScheduleWeekStart, 6) : undefined;
  const pickScheduleDays = (days: OwnScheduleCalendar["days"]) => {
    if (!compactScheduleWeekStart || !compactWeekEnd) return days;
    const inWeek = days.filter(d => d.date >= compactScheduleWeekStart && d.date <= compactWeekEnd);
    return inWeek.length > 0 ? inWeek : days.slice(0, 7);
  };

  return (
    <div className={s.panelSections}>
      <RecordSection
        id="me-att-records"
        title={t("me.attendance.records.title")}
        tools={
          canClock ? (
            <div className={s.sectionTools}>
              <Button
                size="sm"
                variant="primary"
                className={s.nowrap}
                disabled={punch.isPending}
                onClick={() => punch.mutate(nextKind)}
              >
                {t(nextKind === "CLOCK_IN" ? "me.attendance.records.clockIn" : "me.attendance.records.clockOut")}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className={s.sectionWrap}>
          {receipt ? <Receipt state="recorded" message={receipt} /> : null}
          <CommandError
            error={punch.error}
            own={code => (code === "attendance.refuse.missing_grant" ? t("attendance.refuse.missing_grant") : undefined)}
          />
          {recordsQuery ? (
            <QueryState q={recordsQuery} compact>
              {data => (
                <LongTable
                  label={t("me.attendance.records.title")}
                  rows={[...data.items]}
                  rowId={r => r.id}
                  hasMore={false}
                  onLoadMore={() => {}}
                  mobileLayout="compact"
                  empty={<EmptyState compact title={t("me.attendance.records.empty")} reason={null} />}
                  columns={recordCols}
                />
              )}
            </QueryState>
          ) : (
            <LongTable
              label={t("me.attendance.records.title")}
              rows={[...records]}
              rowId={r => r.id}
              hasMore={false}
              onLoadMore={() => {}}
              mobileLayout="compact"
              empty={<EmptyState compact title={t("me.attendance.records.empty")} reason={null} />}
              columns={recordCols}
            />
          )}
        </div>
      </RecordSection>

      <RecordSection id="me-att-exceptions" title={t("me.attendance.exceptions.title")}>
        {exceptionsQuery ? (
          <QueryState q={exceptionsQuery} compact>
            {data => (
              <LongTable
                label={t("me.attendance.exceptions.title")}
                rows={[...data.items]}
                rowId={e => e.id}
                hasMore={false}
                onLoadMore={() => {}}
                mobileLayout="compact"
                empty={<EmptyState compact title={t("me.attendance.exceptions.empty")} reason={null} />}
                columns={exceptionCols}
              />
            )}
          </QueryState>
        ) : (
          <LongTable
            label={t("me.attendance.exceptions.title")}
            rows={[...exceptions]}
            rowId={e => e.id}
            hasMore={false}
            onLoadMore={() => {}}
            mobileLayout="compact"
            empty={<EmptyState compact title={t("me.attendance.exceptions.empty")} reason={null} />}
            columns={exceptionCols}
          />
        )}
      </RecordSection>

      <RecordSection
        id="me-att-schedule"
        title={t("me.attendance.schedule.title")}
        tools={
          fullScheduleLink ? (
            <Link to="/me/attendance" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>
              {t("me.desk.links.fullSchedule")}
            </Link>
          ) : undefined
        }
      >
        <QueryState
          q={schedule}
          compact
          denied={
            <EmptyState
              compact
              title={t("me.attendance.schedule.refusedTitle")}
              reason={t("me.attendance.schedule.refusedReason")}
              meta={<ReadReference error={schedule.error} />}
            />
          }
        >
          {cal => {
            const visibleDays = pickScheduleDays(cal.days);
            return visibleDays.length === 0 ? (
              <EmptyState compact title={t("me.attendance.schedule.empty")} reason={null} />
            ) : (
              <Table
                label={t("me.attendance.schedule.title")}
                rows={visibleDays}
                rowId={d => d.date}
                density="compact"
                mobileLayout="compact"
                columns={scheduleCols}
              />
            );
          }}
        </QueryState>
      </RecordSection>
    </div>
  );
}
