import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { DockSheet } from "../../../ui/dock-sheet/dock-sheet";
import { ItemList } from "../../../ui/item-list/item-list";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Tabs } from "../../../ui/tabs/tabs";
import { personMonthQuery, type Day, type Entry } from "../api";
import { duration } from "../domain/minutes";
import { closed } from "../domain/month-state";
import { dateText, entryText, shiftText, refusalText } from "../present";
import { DayBar } from "./day-bar";
import { EntryForm } from "./entry-form";
import { MarkChip } from "./mark-chip";
import s from "./records.module.css";

type Mode = "view" | "correct" | "void";

/**
 * One person-day (A3 day sheet), docked beside the grid: day (plan, record, recognition and what it means), source (the
 * entries behind it and where each came from), history (every change, voids struck through), and week 52 · approval, which say
 * they arrive with approval record. Its verbs: correction (a new value with a reason), void (back to empty, kept as history),
 * and record again after a void (type in the grid again). The own row and a closed month are read-only.
 */
export function DayDock({ employeeId, date, own, onClose, onRewrite, onDone }: {
  employeeId: string;
  date: string;
  own: boolean;
  onClose: () => void;
  onRewrite: () => void;
  onDone: (message: string) => void;
}) {
  const month = useQuery(personMonthQuery(employeeId, date.slice(0, 7)));
  const [tab, setTab] = useState("day");
  const [mode, setMode] = useState<Mode>("view");
  const day = month.data?.days.find((d) => d.date === date);
  const history = (month.data?.history ?? []).filter((h) => h.date === date);
  const entry = day?.entry ?? null;
  if (mode !== "view" && entry) {
    return <EntryForm employeeId={employeeId} mode={mode} entry={entry} name={month.data?.name ?? ""} date={date} planKind={day?.plan.kind} onClose={() => setMode("view")} onDone={(m) => (setMode("view"), onDone(m))} />;
  }
  const locked = own ? t("attendanceRecords.grid.ownRow") : closed(month.data?.month_state) ? t("attendanceRecords.grid.closedRow") : null;
  const verb = (label: string, go: () => void) =>
    locked ? <DisabledReason reason={locked} control={(p) => <Button {...p}>{label}</Button>} /> : <Button onClick={go}>{label}</Button>;
  return (
    <DockSheet
      open
      kicker={month.data ? `${month.data.name} ${month.data.employee_number ?? ""}` : t("common.loading")}
      title={t("attendanceRecords.day.title", { date: dateText(date) })}
      onClose={onClose}
      consequence={t("attendanceRecords.recognition.basis")}
      actions={
        <div className={s.dayActions}>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          <div className="row">
          {entry && entry.kind !== "VOID" && verb(t("attendanceRecords.day.correct"), () => setMode("correct"))}
          {entry && entry.kind !== "VOID" && verb(t("attendanceRecords.day.void"), () => setMode("void"))}
          {month.data && (!entry || entry.kind === "VOID") && verb(t("attendanceRecords.day.rewrite"), onRewrite)}
          </div>
        </div>
      }
    >
      <QueryState q={month} own={refusalText}>
        {() => (
          <Tabs
            label={t("attendanceRecords.day.tabs")}
            selected={tab}
            onSelect={setTab}
            items={(["day", "source", "history", "week", "approval"] as const).map((id) => ({ id, label: t(`attendanceRecords.day.tab.${id}`) }))}
          >
            {(id) => (id === "day" && day ? <DayPanel day={day} /> : id === "source" || id === "history" ? <History rows={id === "source" ? history.filter((h) => !h.entry.undone && h.entry.kind !== "VOID").slice(0, 1) : history.map((h) => h.entry)} /> : <p className="muted">{t("attendanceRecords.day.laterTab")}</p>)}
          </Tabs>
        )}
      </QueryState>
    </DockSheet>
  );
}

function DayPanel({ day }: { day: Day }) {
  const r = day.recognition;
  return (
    <>
      <DayBar day={day} />
      <KeyValue
        items={[
          { key: "plan", label: t("attendanceRecords.day.plan"), value: day.plan.shift ? shiftText(day.plan.shift) : t(`attendance.dayKind.${day.plan.kind}`) },
          { key: "recorded", label: t("attendanceRecords.day.recorded"), value: day.entry ? entryText(day.entry.kind, day.entry.segments) : t("attendanceRecords.day.none") },
          { key: "recognised", label: t("attendanceRecords.day.recognised"), value: t("attendanceRecords.day.recognisedValue", { recognised: duration(r.recognised), regular: duration(r.regular) }) },
          { key: "outside", label: t("attendanceRecords.day.outside"), value: t("attendanceRecords.day.outsideValue", { early: duration(r.early_unrecognised), late: duration(r.late_unrecognised) }) },
          { key: "notWorked", label: t("attendanceRecords.day.notWorked"), value: t("attendanceRecords.day.notWorkedValue", { late: r.late_in, early: r.early_out, away: r.away }) },
        ]}
      />
      {day.marks.length > 0 && <div className="row">{day.marks.map((m) => <MarkChip key={m} mark={m} />)}</div>}
    </>
  );
}

function History({ rows }: { rows: Entry[] | { entry: Entry }[] }) {
  const list = rows.map((x) => ("entry" in x ? x.entry : x));
  if (!list.length) return <p className="muted">{t("attendanceRecords.day.noHistory")}</p>;
  return (
    <ItemList
      label={t("attendanceRecords.day.historyLabel")}
      items={list.map((e) => ({
        key: e.id,
        text: (
          <>
            {e.kind === "VOID" || e.undone ? <s>{entryText(e.kind, e.segments)}</s> : entryText(e.kind, e.segments)} · {t(`attendanceRecords.source.${e.source}`)} · {t(`attendanceRecords.evidence.${e.evidence_kind}`)}
            {e.reason && <> · {e.reason}</>}
            {e.undone && <> · {t("attendanceRecords.day.undone")}</>}
          </>
        ),
        end: <span className="muted">{e.created_by_name} {fmtDateTime(e.created_at)}</span>,
      }))}
    />
  );
}
