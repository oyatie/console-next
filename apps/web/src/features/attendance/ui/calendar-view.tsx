import { EmptyState } from "../../../ui/empty-state";
import { Banner } from "../../../ui/banner/banner";
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Button, IconButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { ItemList } from "../../../ui/item-list/item-list";
import { SectionHead } from "../../../ui/card/section-head";
import { MonthGrid, type DayTone } from "../../../ui/month-grid/month-grid";
import { calendarQuery, type Calendar, type Layer, type ScheduleDay, type ScheduleTree, type ScopeKind } from "../api";
import { monthOf, monthWeeks, shiftMonth } from "../domain/month";
import type { TreeNode } from "../domain/tree";
import { dateText, monthText, shiftText, weekdayText } from "../present";
import type { AssignTarget } from "./assign-sheet";
import type { AttendanceSearch } from "./attendance-page";
import { LayerHistory } from "./layer-history";
import { LayerStack } from "./layer-stack";
import { ScopeTree } from "./scope-tree";
import { inField, useKeys } from "./use-keys";
import s from "./attendance.module.css";

const HOLIDAY = new Set(["PUBLIC_HOLIDAY", "SUBSTITUTE_HOLIDAY", "ELECTION_DAY", "LABOR_DAY", "CONTRACTUAL_HOLIDAY"]);
const tone = (d?: ScheduleDay): DayTone | undefined => (!d ? undefined : HOLIDAY.has(d.kind) ? "holiday" : d.kind === "WEEKLY_HOLIDAY" || d.kind === "REST_DAY" ? "rest" : undefined);

/** The month's most common shift: a working day that keeps it says nothing ("cells show only days that differ"). */
function usual(days: readonly ScheduleDay[]): string | undefined {
  const n = new Map<string, number>();
  for (const d of days) if (d.kind === "WORK" && d.shift) n.set(shiftText(d.shift), (n.get(shiftText(d.shift)) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function DayCell({ d, common }: { d?: ScheduleDay; common?: string }) {
  if (!d) return null;
  const shift = d.shift ? shiftText(d.shift) : undefined;
  return (
    <span className={s.dayCell}>
      {d.holiday_name && <strong>{d.holiday_name}</strong>}
      {d.kind !== "WORK" && <span>{t(`attendance.dayKind.${d.kind}`)}</span>}
      {d.slot_code && <Chip>{d.slot_code}</Chip>}
      {(d.holiday_work || (d.kind === "WORK" && shift !== common)) && shift && <span>{shift}</span>}
      {d.holiday_work && <span>{t("attendancePatterns.day.holidayWork")}</span>}
    </span>
  );
}

/**
 * A2 calendar: the scope tree, the scope's month (each day: the scheduled that decides it, holidays from the bundled reference
 * data and company holiday), and the layer stack with the one primary, "Assign a schedule to this scope". `[` `]` step the month
 * while focus is in the calendar (never in a text field).
 */
export function CalendarView({ tree, search, onScope, onMonth, onAssign, onCancel, onAddPattern }: {
  tree: ScheduleTree;
  search: AttendanceSearch;
  onScope: (kind: ScopeKind, id: string) => void;
  onMonth: (month: string) => void;
  onAssign: (targets: AssignTarget[]) => void;
  onCancel: (l: Layer) => void;
  onAddPattern: () => void;
}) {
  const fallback = tree.nodes.find((n) => n.kind === "WORKPLACE") ?? tree.nodes[0];
  const scope = search.kind && search.id ? { kind: search.kind, id: search.id } : fallback && { kind: fallback.kind, id: fallback.id };
  const month = search.month ?? monthOf(todayKst());
  const weeks = useMemo(() => monthWeeks(month), [month]);
  const cal = useQuery({ ...calendarQuery(scope?.kind ?? "WORKPLACE", scope?.id ?? "", month), placeholderData: keepPreviousData, enabled: !!scope });
  const keys = useKeys<HTMLDivElement>((e) => {
    if (inField(e) || (e.key !== "[" && e.key !== "]")) return false;
    onMonth(shiftMonth(month, e.key === "[" ? -1 : 1));
    return true;
  });
  if (!scope) return <EmptyState title={t("attendanceSchedule.calendar.empty")} reason={t("attendanceSchedule.calendar.empty.reason")} actions={<Button variant="primary" onClick={onAddPattern}>{t("attendancePatterns.types.add")}</Button>} />;
  return (
    <QueryState q={cal} layout="grid">{c => <div ref={keys} className={s.calendarLayout}>
      <ScopeTree tree={tree} selected={scope.id} onSelect={(n: TreeNode) => onScope(n.kind, n.id)} onPerson={(id) => onScope("PERSON", id)} />
      <div className={s.centerCol}>
        <div className={s.toolbar}>
          <IconButton label={t("attendanceSchedule.month.prev")} onClick={() => onMonth(shiftMonth(month, -1))}><ChevronLeft size={16} aria-hidden /></IconButton>
          <strong className={s.monthText}>{monthText(month)}</strong>
          <IconButton label={t("attendanceSchedule.month.next")} onClick={() => onMonth(shiftMonth(month, 1))}><ChevronRight size={16} aria-hidden /></IconButton>
        </div>
        <Month c={c} month={month} weeks={weeks} />
        <LayerHistory kind={scope.kind} id={scope.id} onCancel={onCancel} />
      </div>
      <aside className={s.sideCol} aria-label={t("attendanceSchedule.side.label")}>
        <LayerStack calendar={c} />
        <Button variant="primary" onClick={() => onAssign([{ kind: c.scope_kind, id: c.scope_id, name: c.scope_name }])}>
                <Plus size={16} aria-hidden /> {t("attendanceSchedule.assign.open")}
              </Button>
        <MonthHolidays c={c} />
      </aside>
    </div>}</QueryState>
  );
}

function Month({ c, month, weeks }: { c: Calendar; month: string; weeks: string[][] }) {
  const byDate = new Map(c.days.map((d) => [d.date, d]));
  const common = usual(c.days);
  const winner = c.stack.find((e) => e.wins);
  return (
    <>
      <p className={s.scopeLine}>
        {winner?.layer
          ? t("attendanceSchedule.calendar.scopeLine", { scope: c.scope_name, pattern: winner.layer.pattern_name, shift: common ?? "", decided: winner.scope_name ?? "" })
          : t("attendanceSchedule.calendar.noSchedule", { scope: c.scope_name })}
      </p>
      <MonthGrid
        label={t("attendanceSchedule.calendar.label", { scope: c.scope_name, month: monthText(month) })}
        weeks={weeks}
        weekdays={weeks[0]!.map(weekdayText)}
        inMonth={(d) => monthOf(d) === month}
        tone={(d) => tone(byDate.get(d))}
        cell={(d) => <DayCell d={byDate.get(d)} common={common} />}
      />
    </>
  );
}

function MonthHolidays({ c }: { c: Calendar }) {
  const days = c.days.filter((d) => HOLIDAY.has(d.kind));
  return (
    <section aria-labelledby="att-month-hol">
      <SectionHead id="att-month-hol" level={3}>{t("attendanceSchedule.monthHolidays.title")}</SectionHead>
      {days.length ? (
        <ItemList label={t("attendanceSchedule.monthHolidays.title")} items={days.map((d) => ({ key: d.date, text: <><strong>{dateText(d.date)} {d.holiday_name}</strong><br /><span className="muted">{t(`attendance.dayKind.${d.kind}`)}</span></> }))} />
      ) : (
        <p className="muted">{t("attendanceSchedule.monthHolidays.none")}</p>
      )}
      {!c.holidays_loaded && <Banner tone="warn">{t("attendanceSchedule.monthHolidays.notLoaded")}</Banner>}
    </section>
  );
}
