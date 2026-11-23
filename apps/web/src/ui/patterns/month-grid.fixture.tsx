// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { Segmented } from "../button/segmented";
import { Chip } from "../chip";
import { StatRow } from "../key-value/key-value";
import { PaneHead } from "../pane-grid/pane-grid";
import { PeriodStepper } from "../period-stepper/period-stepper";
import { PersonDayGrid, type DayColumn, type Range } from "../person-day-grid/person-day-grid";
import { Sheet } from "../sheet/sheet";
import { Table } from "../table";
import { MonthGridPattern } from "./month-grid";
import fx from "./pattern-fixture.module.css";

const DAYS: readonly DayColumn[] = Array.from({ length: 18 }, (_, i) => {
  const n = i + 1;
  return {
    key: `d${n}`,
    label: String(n),
    sub: n % 7 === 3 || n % 7 === 4 ? "S" : "W",
    tone: n % 7 === 3 || n % 7 === 4 ? "rest" : undefined,
  };
});

type GridRow = { id: string; code: string; total: string; nameKey?: "search.person" | "links.person" | "facts.repValue"; n?: number };

const ROWS: readonly GridRow[] = [
  { id: "10587", nameKey: "search.person", code: "10587", total: "18" },
  { id: "10516", nameKey: "links.person", code: "10516", total: "17" },
  { id: "10313", nameKey: "facts.repValue", code: "10313", total: "17" },
  { id: "10414", n: 4, code: "10414", total: "17" },
  { id: "10110", n: 5, code: "10110", total: "17.5" },
  { id: "10261", n: 6, code: "10261", total: "16" },
  { id: "10570", n: 7, code: "10570", total: "18" },
  { id: "10618", n: 8, code: "10618", total: "16" },
  { id: "10578", n: 9, code: "10578", total: "16.5" },
  { id: "10648", n: 10, code: "10648", total: "19" },
];

const READY: ReadState = { isPending: false, error: null, data: ROWS, refetch() {} };

/** Synthetic no-network showcase for MonthGrid (`P5`). */
export default function MonthGridExample({ q = READY }: { q?: ReadState }) {
  const [period, setPeriod] = useState("2026-10");
  const [filter, setFilter] = useState<"all" | "ex">("all");
  const [range, setRange] = useState<Range | null>({
    anchor: { row: "10587", col: "d1" },
    focus: { row: "10587", col: "d1" },
  });
  const [editing, setEditing] = useState<{ value: string; cell: { row: string; col: string } } | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const rowName = (r: GridRow) => (r.nameKey ? tg(r.nameKey) : tg("sample.person", { n: r.n ?? 1 }));
  const cellText = (_r: GridRow, c: number) => (c % 5 === 2 ? "+2" : "·");
  const legendWork = `· ${t("attendance.dayKind.WORK")}`;
  const legendOt = `+2 ${t("attendance.overtime.approved")}`;
  const exRows = [
    { id: "10516", date: "10-19", code: "10516", name: tg("links.person"), kind: t("attendance.exception.LATE") },
    { id: "10570", date: "10-21", code: "10570", name: tg("sample.person", { n: 7 }), kind: t("attendance.exception.UNAPPROVED_OVERTIME") },
    { id: "10618", date: "10-26", code: "10618", name: tg("sample.person", { n: 8 }), kind: t("attendance.exception.NO_SHOW") },
  ];

  return (
    <MonthGridPattern
      q={q}
      head={{
        title: t("attendance.title"),
        titleId: "month-grid-title",
        filters: (
          <>
            <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={period} onChange={setPeriod} />
            <Segmented
              label={t("attendance.tabs")}
              value={filter}
              onChange={setFilter}
              items={[
                { id: "all", label: t("home.inbox.filter.all") },
                { id: "ex", label: t("attendance.exception.OPEN"), count: exRows.length, tone: "warn" },
              ]}
            />
          </>
        ),
        primary: { id: "close", label: t("attendance.tab.close"), onAction: () => setSheetOpen(true) },
      }}
      summary={
        <StatRow
          label={t("attendance.title")}
          items={[
            { key: "scope", label: t("attendanceRecords.scope.label"), value: "12" },
            { key: "days", label: t("attendanceRecords.card.scheduledDays"), value: "18" },
            { key: "hol", label: t("attendance.dayKind.PUBLIC_HOLIDAY"), value: "4" },
            { key: "leave", label: t("enum.importTarget.leave_used"), value: "10.5" },
            { key: "ot", label: t("attendance.overtime.approved"), value: "53h" },
            {
              key: "ex",
              label: t("attendance.exception.OPEN"),
              value: String(exRows.length),
              meta: `${t("attendance.exception.LATE")} 1 · ${t("attendance.exception.NO_SHOW")} 1`,
              tone: "warn",
            },
          ]}
        />
      }
      grid={
        <PersonDayGrid
          label={t("attendanceRecords.grid.label")}
          total={ROWS.length}
          rows={ROWS}
          rowKey={r => r.id}
          lead={[
            { key: "name", header: t("attendanceRecords.grid.name"), width: "name", cell: r => rowName(r) },
            { key: "code", header: t("attendanceRecords.grid.number"), width: "code", cell: r => r.code },
          ]}
          days={DAYS}
          tail={[{ key: "tot", header: t("attendanceRecords.total.recognised"), width: "total", cell: r => r.total }]}
          cell={cellText}
          look={(r, c) => (r.id === "10516" && c === 10 ? "draft" : undefined)}
          describe={(r, c) => `${rowName(r)} ${c + 1} ${cellText(r, c)}`}
          range={range}
          onRange={setRange}
          editing={editing}
          onEdit={v => setEditing(v === null || !range ? null : { value: v, cell: range.focus })}
          onCommit={() => setEditing(null)}
          onKey={() => false}
        />
      }
      bottom={
        <div className={fx.bottomSplit}>
          <div className={fx.bottomCol}>
            <PaneHead title={t("attendance.exception.OPEN")} meta={String(exRows.length)} />
            <Table
              label={t("attendance.exception.OPEN")}
              mobileLayout="compact"
              rows={exRows}
              rowId={r => r.id}
              onSelect={() => setDockOpen(true)}
              columns={[
                { header: t("attendanceRecords.grid.name"), cell: r => r.name },
                { header: t("attendance.col.date"), wide: true, fit: true, cell: r => <bdi className="num">{r.date}</bdi> },
                { header: t("attendance.col.kind"), cell: r => r.kind },
                {
                  header: t("attendance.col.state"),
                  card: "status",
                  fit: true,
                  cell: () => <Chip tone="warn">{t("attendance.exception.OPEN")}</Chip>,
                },
                {
                  header: <bdi className="sr-only">{tg("columns.action")}</bdi>,
                  card: "action",
                  fit: true,
                  cell: () => (
                    <Button size="sm" variant="secondary" onClick={() => setDockOpen(true)}>
                      {tg("columns.open")}
                    </Button>
                  ),
                },
              ]}
            />
          </div>
          <div className={fx.bottomCol}>
            <PaneHead title={t("attendanceRecords.total.recognised")} />
            <div className={fx.bandPad}>{t("attendance.firstRun.reason", { people: 12 })}</div>
            <div className={fx.legendGrid}>
              <div className={fx.legendItem}>{legendWork}</div>
              <div className={fx.legendItem}>{t("attendance.dayKind.WEEKLY_HOLIDAY")}</div>
              <div className={fx.legendItem}>{legendOt}</div>
              <div className={fx.legendItem}>{t("attendance.exception.LATE")}</div>
            </div>
          </div>
        </div>
      }
      record={
        dockOpen
          ? {
              id: "dock",
              label: t("attendanceRecords.day.tab.day"),
              title: t("attendanceRecords.day.tab.day"),
              onClose: () => setDockOpen(false),
              children: <div className={fx.bandPad}>{tg("sample.team")}</div>,
            }
          : null
      }
      overlays={
        <Sheet
          open={sheetOpen}
          title={t("attendance.tab.close")}
          onClose={() => setSheetOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setSheetOpen(false)}>{t("common.cancel")}</Button>}
        >
          {t("attendance.firstRun.reason", { people: 12 })}
        </Sheet>
      }
    />
  );
}
