// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { ItemList } from "../../../ui/item-list/item-list";
import { StatRow } from "../../../ui/key-value/key-value";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { type DayBoard } from "../api";
import { cellKey, fillSchedule } from "../domain/grid";
import { closed } from "../domain/month-state";
import { DayDock } from "./day-dock";
import { DayRow } from "./day-row";
import { SaveDock } from "./save-dock";
import s from "./attendance-console.module.css";

type DayGroup = DayBoard["groups"][number];
type Row = DayGroup["rows"][number];
type DraftMap = ComponentProps<typeof SaveDock>["drafts"];
type KindFn = ComponentProps<typeof SaveDock>["kindOf"];

export function DayLedgerStats({ ledger }: { ledger: DayBoard["ledger"] }) {
  if (ledger.people <= 0) return null;
  return (
    <StatRow
      label={t("attendance.tab.day")}
      items={[
        { key: "people", label: t("attendance.monthConsole.summary.scope"), value: t("attendance.people", { count: ledger.people }) },
        { key: "normal", label: t("attendanceRecords.ledger.normal", { count: ledger.normal }), value: ledger.normal, tone: "ok" },
        { key: "noRecord", label: t("attendanceRecords.mark.NO_RECORD"), value: ledger.no_record, tone: ledger.no_record > 0 ? "danger" : undefined },
        { key: "missingOut", label: t("attendanceRecords.mark.MISSING_OUT"), value: ledger.missing_out, tone: ledger.missing_out > 0 ? "danger" : undefined },
        { key: "lateEarly", label: t("attendanceRecords.ledger.late_or_early", { count: ledger.late_or_early }), value: ledger.late_or_early, tone: ledger.late_or_early > 0 ? "warn" : undefined },
        { key: "unscheduled", label: t("attendanceRecords.mark.NO_SCHEDULE"), value: ledger.no_schedule, tone: ledger.no_schedule > 0 ? "warn" : undefined },
      ]}
    />
  );
}

export function DayGroupSections({
  groups,
  date,
  grammarHintId,
  drafts,
  onPutDraft,
  onExpandUnit,
  onOpenRow,
  onAssignRow,
}: {
  groups: readonly DayGroup[];
  date: string;
  grammarHintId: string;
  drafts: DraftMap;
  onPutDraft: (key: string, value: string | null, entryId: string | null) => void;
  onExpandUnit: (unitId: string) => void;
  onOpenRow: (row: Row) => void;
  onAssignRow: (row: Row) => void;
}) {
  return (
    <>
      {groups.map(g => (
        <section key={`${g.workplace_id}-${g.unit_id}`} className={s.groupSection}>
          <div className={s.scheduleHeader}>
            <div>
              <h3 className="t-label">{g.name}</h3>
              <bdi className="muted t-xs">
                {t("attendanceRecords.board.groupMeta", {
                  people: g.people,
                  normal: g.normal,
                  unscheduled: g.no_schedule,
                  blocking: g.marks.blocking,
                  decision: g.marks.decision,
                })}
              </bdi>
            </div>
            {g.hidden > 0 && g.unit_id ? (
              <Button size="sm" variant="ghost" onClick={() => onExpandUnit(g.unit_id!)}>
                {t("attendanceRecords.board.expand", { count: g.hidden })}
              </Button>
            ) : null}
          </div>
          <div className={s.groupRows}>
            {g.rows.map(r => (
              <div key={r.employee_id} className={s.groupRowWrap}>
                <DayRow
                  row={r}
                  grammarHintId={grammarHintId}
                  draft={drafts[cellKey(r.employee_id, date)]}
                  onDraft={v => onPutDraft(cellKey(r.employee_id, date), v, r.day.entry?.id ?? null)}
                  onOpen={() => onOpenRow(r)}
                  onAssign={() => onAssignRow(r)}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function DayConsoleRail({
  peopleCount,
  openCount,
  blockingGroups,
  date,
  drafts,
  onSetDrafts,
  onSetNote,
  onGoIssues,
}: {
  peopleCount: number;
  openCount: number;
  blockingGroups: readonly DayGroup[];
  date: string;
  drafts: DraftMap;
  onSetDrafts: (next: DraftMap) => void;
  onSetNote: (msg: string) => void;
  onGoIssues: () => void;
}) {
  if (peopleCount <= 0 || (openCount === 0 && blockingGroups.length === 0)) return undefined;
  return (
    <RecordPaneSection
      title={t("attendanceRecords.rail.title")}
      trailing={
        openCount > 0 ? (
          <Button size="sm" variant="secondary" onClick={onGoIssues}>
            {t("attendanceRecords.rail.process", { count: openCount })}
          </Button>
        ) : undefined
      }
    >
      {blockingGroups.length > 0 ? (
        <ItemList
          label={t("attendanceRecords.rail.groups")}
          items={blockingGroups.map(g => ({
            key: `${g.workplace_id}-${g.unit_id}`,
            text: t("attendanceRecords.rail.groupLine", { name: g.name, blocking: g.marks.blocking }),
            end: g.rows.some(r => r.day.marks.includes("NO_RECORD")) ? (
              <Button
                size="sm"
                onClick={() => {
                  const result = fillSchedule(
                    g.rows.map(r => ({
                      key: cellKey(r.employee_id, date),
                      planKind: r.day.plan.kind,
                      entryId: r.day.entry?.id ?? null,
                      own: r.own,
                      closed: closed(r.month_state),
                    })),
                    drafts,
                  );
                  onSetDrafts(result.drafts);
                  onSetNote(t("attendanceRecords.fill.done", { filled: result.filled, ...result.skipped }));
                }}
              >
                {t("attendanceRecords.rail.asScheduled")}
              </Button>
            ) : g.no_schedule > 0 ? (
              <Link
                to="/attendance"
                search={{ tab: "day", date, wp: g.workplace_id ?? undefined, unit: g.unit_id ?? undefined, unscheduled: true }}
              >
                {t("attendanceRecords.unscheduled.view", { count: g.no_schedule })}
              </Link>
            ) : undefined,
          }))}
        />
      ) : null}
    </RecordPaneSection>
  );
}

export function DaySavePaneBody({
  drafts,
  rows,
  kindOf,
  month,
  onClose,
  onSaved,
}: {
  drafts: DraftMap;
  rows: readonly Row[];
  kindOf: KindFn;
  month: string;
  onClose: () => void;
  onSaved: (r: { saved: number; opens: { blocking: number; decision: number } }, keys: string[]) => void;
}) {
  return (
    <SaveDock
      variant="pane"
      drafts={drafts}
      rows={rows}
      kindOf={kindOf}
      month={month}
      onClose={onClose}
      onFocusCell={onClose}
      onSaved={onSaved}
    />
  );
}

export function DayOpenPaneBody({
  employeeId,
  date,
  own,
  onClose,
  onSetNote,
}: {
  employeeId: string;
  date: string;
  own: boolean;
  onClose: () => void;
  onSetNote: (msg: string) => void;
}) {
  return (
    <DayDock
      employeeId={employeeId}
      date={date}
      own={own}
      onClose={onClose}
      onRewrite={onClose}
      onDone={m => {
        onClose();
        onSetNote(m);
      }}
    />
  );
}
