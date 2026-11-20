// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { Segmented } from "../button/segmented";
import { StatRow } from "../key-value/key-value";
import { PaneHead } from "../pane-grid/pane-grid";
import { PeriodStepper } from "../period-stepper/period-stepper";
import { PersonDayGrid, type DayColumn, type Range } from "../person-day-grid/person-day-grid";
import { Sheet } from "../sheet/sheet";
import { Table } from "../table";
import { MonthGridPattern } from "./month-grid";
import fx from "./pattern-fixture.module.css";

const DAYS: readonly DayColumn[] = Array.from({ length: 14 }, (_, i) => {
  const n = i + 1;
  return { key: `d${n}`, label: String(n), sub: n % 7 === 3 || n % 7 === 4 ? "S" : "W", tone: n % 7 === 3 || n % 7 === 4 ? "rest" : undefined };
});

const ROWS = [
  { id: "10587", name: "Yoon", code: "10587", total: "18" },
  { id: "10516", name: "Seok", code: "10516", total: "17" },
] as const;

const READY: ReadState = { isPending: false, error: null, data: ROWS, refetch() {} };

/** Synthetic no-network showcase for MonthGrid (`P5`). */
export default function MonthGridExample({ q = READY }: { q?: ReadState }) {
  const [period, setPeriod] = useState("2026-10");
  const [filter, setFilter] = useState<"all" | "ex">("all");
  const [range, setRange] = useState<Range | null>({ anchor: { row: "10587", col: "d1" }, focus: { row: "10587", col: "d1" } });
  const [editing, setEditing] = useState<{ value: string; cell: { row: string; col: string } } | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <MonthGridPattern
      q={q}
      head={{
        title: tg("pat.month.head"),
        titleId: "month-grid-title",
        filters: (
          <>
            <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={period} onChange={setPeriod} />
            <Segmented
              label={tg("pat.month.scope")}
              value={filter}
              onChange={setFilter}
              items={[
                { id: "all", label: tg("pat.month.filterAll") },
                { id: "ex", label: tg("pat.month.filterEx"), count: 2, tone: "warn" },
              ]}
            />
          </>
        ),
        primary: { id: "close", label: tg("pat.month.exTitle"), onAction: () => setSheetOpen(true) },
      }}
      summary={
        <StatRow
          label={tg("pat.month.head")}
          items={[
            { key: "scope", label: tg("pat.month.scope"), value: "12" },
            { key: "days", label: tg("pat.month.statDays"), value: "18" },
            { key: "hol", label: tg("pat.month.statHoliday"), value: "4" },
            { key: "leave", label: tg("pat.month.statLeave"), value: "10.5" },
            { key: "ot", label: tg("pat.month.statOt"), value: "53h" },
            { key: "ex", label: tg("pat.month.statEx"), value: "2", meta: tg("pat.month.statExMeta"), tone: "warn" },
          ]}
        />
      }
      grid={
        <PersonDayGrid
          label={tg("personDayGrid.label")}
          total={ROWS.length}
          rows={ROWS}
          rowKey={r => r.id}
          lead={[
            { key: "name", header: tg("search.label"), width: "name", cell: r => r.name },
            { key: "code", header: tg("personDayGrid.number"), width: "code", cell: r => r.code },
          ]}
          days={DAYS}
          tail={[{ key: "tot", header: tg("personDayGrid.total"), width: "total", cell: r => r.total }]}
          cell={() => "·"}
          look={(_r, c) => (c === 10 ? "draft" : undefined)}
          describe={(r, c) => `${r.name} ${c + 1}`}
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
            <PaneHead title={tg("pat.month.exTitle")} />
            <Table
              label={tg("pat.month.exTitle")}
              mobileLayout="compact"
              rows={[...ROWS]}
              rowId={r => r.id}
              onSelect={() => setDockOpen(true)}
              columns={[
                { header: tg("personDayGrid.number"), fit: true, cell: r => r.code },
                { header: tg("search.label"), cell: r => r.name },
              ]}
            />
          </div>
          <div className={fx.bottomCol}>
            <PaneHead title={tg("pat.month.exRule")} />
            <div className={fx.bandPad}>{tg("pat.month.exRule")}</div>
          </div>
        </div>
      }
      record={
        dockOpen
          ? {
              id: "dock",
              label: tg("pat.month.dockTitle"),
              title: tg("pat.month.dockTitle"),
              onClose: () => setDockOpen(false),
              children: <div className={fx.bandPad}>{tg("pat.month.scope")}</div>,
            }
          : null
      }
      overlays={
        <Sheet
          open={sheetOpen}
          title={tg("pat.month.exTitle")}
          onClose={() => setSheetOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setSheetOpen(false)}>{t("common.cancel")}</Button>}
        >
          {tg("pat.month.exRule")}
        </Sheet>
      }
    />
  );
}
