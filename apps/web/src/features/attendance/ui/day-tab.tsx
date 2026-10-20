import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { todayKst } from "../../../lib/pure/today";
import { Banner } from "../../../ui/banner/banner";
import { Button, IconButton, ToggleButton } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { ItemList } from "../../../ui/item-list/item-list";
import { addDays } from "../../../ui/date/days";
import { dayBoardQuery } from "../api";
import { baseOf, cellKey, fillSchedule, ledgerParts } from "../domain/grid";
import { closed, pageState } from "../domain/month-state";
import { dateText, refusalText } from "../present";
import { DayDetail } from "./day-detail";
import { DayDock } from "./day-dock";
import { DayRow } from "./day-row";
import { MonthStateBanner } from "./month-state-banner";
import { SaveDock } from "./save-dock";
import { ScopePicker } from "./scope-picker";
import { PersonScheduleSheet } from "./person-schedule-sheet";
import type { AssignTarget } from "./assign-sheet";
import { useDrafts } from "./use-drafts";
import { useOnline } from "../../../lib/react/use-online";
import { usePlanKinds } from "./use-plan-kinds";
import s from "./records.module.css";

const route = getRouteApi("/app/attendance");

/**
 * Day (A1-day simple · A3-entry detailed): one day, yesterday by default. The ledger line partitions everyone in scope (G8);
 * groups workplace › department fold their clean rows; issue rows come first, each with its sentence and one verb. Today is judged
 * only after it ends. Drafts typed here are saved through the same save sheet as the month grid.
 */
export function DayTab({ head }: { head?: ReactNode }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const date = search.date ?? addDays(todayKst(), -1);
  const board = useQuery({ ...dayBoardQuery(date, search.wp, search.unit, search.issues, search.unscheduled, search.detail ? "all" : undefined), placeholderData: keepPreviousData });
  const rows = useMemo(() => board.data?.groups.flatMap(g => g.rows) ?? [], [board.data]);
  const kindOf = usePlanKinds(rows, date);
  const store = useDrafts(`day:${date}`);
  const online = useOnline();
  const [save, setSave] = useState(false);
  const [open, setOpen] = useState<{ id: string; own: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [assign, setAssign] = useState<AssignTarget | null>(null);
  const go = (patch: Record<string, unknown>) => void navigate({ search: (x) => ({ ...x, ...patch }) });
  const drafts = Object.keys(store.drafts).length;
  const feedback = [drafts > 0 && t("attendanceRecords.toolbar.unsaved", { count: drafts, refused: 0 }), note, store.problem && t(`attendanceRecords.drafts.${store.problem}`)].filter(Boolean).join(" · ");
  const saveWhy = !online ? t("attendanceRecords.save.offline") : null;
  const empty = board.data?.ledger.people === 0;
  const restoringDetail = search.detail && board.isPlaceholderData && board.data?.groups.some(g => g.hidden > 0);

  return (
    <div className={s.dayPage}>
      {head}
      <PageReadGate q={board} own={refusalText} recovery={search.wp ? <ScopePicker value={search.wp} onChange={(wp) => go({ wp, unit: undefined })} /> : undefined}>
      {!empty && <div className={s.toolbar} role="toolbar" aria-label={t("attendanceRecords.toolbar.label")}>
        <ScopePicker value={search.wp} onChange={(wp) => go({ wp, unit: undefined })} />
        <div className={s.stepper}>
          <IconButton size="sm" label={t("attendanceRecords.toolbar.prevDay")} onClick={() => go({ date: addDays(date, -1) })}><ChevronLeft size={16} aria-hidden /></IconButton>
          <span className={s.stepText}>{dateText(date)}</span>
          <IconButton size="sm" label={t("attendanceRecords.toolbar.nextDay")} onClick={() => go({ date: addDays(date, 1) })}><ChevronRight size={16} aria-hidden /></IconButton>
        </div>
        <ToggleButton size="sm" pressed={!!search.issues} onClick={() => go({ issues: search.issues ? undefined : true })}>{t("attendanceRecords.board.issuesOnly")}</ToggleButton>
        <ToggleButton size="sm" pressed={!!search.unscheduled} onClick={() => go({ unscheduled: search.unscheduled ? undefined : true })}>{t("attendanceRecords.unscheduled.only")}</ToggleButton>
        <ToggleButton size="sm" pressed={!search.detail} onClick={() => go({ detail: undefined })}>{t("attendanceRecords.board.simple")}</ToggleButton>
        <ToggleButton size="sm" pressed={!!search.detail} onClick={() => go({ detail: true })}>{t("attendanceRecords.board.detail")}</ToggleButton>
        {drafts > 0 && <>
          {saveWhy ? <DisabledReason reason={saveWhy} control={(p) => <Button {...p} variant="primary">{t("attendanceRecords.toolbar.save")}</Button>} /> : <Button variant="primary" onClick={() => setSave(true)}>{t("attendanceRecords.toolbar.save")}</Button>}
        </>}
      </div>}
      {feedback && <p className="muted" role="status">{feedback}</p>}

      <QueryState q={restoringDetail ? { ...board, isPending: true } : board} own={refusalText} layout="grid">{b => {
        const ledger = ledgerParts(b.ledger);
        return <>
            <div className={s.monthLayout} data-docked={save || open ? "" : undefined}>
              <div className={s.dayLayout}>
                <div className={s.dayPage}>
                  <MonthStateBanner state={pageState(b.groups.flatMap((g) => g.rows.map((r) => r.month_state)))} month={date.slice(0, 7)} />
                  {!b.judged && <Banner tone="info">{t("attendanceRecords.board.notJudged")}</Banner>}
                  <p className="num">
                    {t("attendanceRecords.board.ledgerHead", { people: b.ledger.people })}{" "}
                    {ledger.parts.filter(([, n]) => n > 0).map(([k, n]) => t(`attendanceRecords.ledger.${k}`, { count: n })).join(" + ")}
                  </p>
                  {!ledger.adds && <Banner tone="warn">{t("attendanceRecords.board.ledgerGap")}</Banner>}
                  {!b.groups.length ? (
                    search.issues || search.unscheduled ? (
                      <EmptyState title={t("attendanceRecords.empty.filteredTitle")} reason={t("attendanceRecords.board.noIssues")} actions={<Button onClick={() => go({ issues: undefined, unscheduled: undefined, wp: undefined, unit: undefined })}>{t("attendanceRecords.empty.clear")}</Button>} />
                    ) : (
                      <EmptyState title={t("attendanceRecords.empty.title")} reason={t("attendanceRecords.empty.reason")} actions={<Link to="/attendance" search={{ tab: "schedule" }}>{t("attendanceRecords.empty.toSchedule")}</Link>} />
                    )
                  ) : search.detail ? (
                    <DayDetail board={b} store={store} onAssign={(r) => setAssign({ kind: "PERSON", id: r.employee_id, name: r.name })} />
                  ) : (
                    b.groups.map((g) => (
                      <Card
                        key={`${g.workplace_id}-${g.unit_id}`}
                        title={g.name}
                        meta={<>{t("attendanceRecords.board.groupMeta", { people: g.people, normal: g.normal, unscheduled: g.no_schedule, blocking: g.marks.blocking, decision: g.marks.decision })}{g.no_schedule > 0 && <> · <Link to="/attendance" search={{ tab: "day", date, wp: g.workplace_id ?? undefined, unit: g.unit_id ?? undefined, unscheduled: true }}>{t("attendanceRecords.unscheduled.view", { count: g.no_schedule })}</Link></>}</>}
                        tools={g.hidden > 0 && g.unit_id ? <Button size="sm" variant="ghost" onClick={() => go({ unit: g.unit_id })}>{t("attendanceRecords.board.expand", { count: g.hidden })}</Button> : undefined}
                      >
                        {g.rows.map((r) => (
                          <DayRow key={r.employee_id} row={r} draft={store.drafts[cellKey(r.employee_id, date)]} onDraft={(v) => store.put(cellKey(r.employee_id, date), v ? { value: v, base: baseOf(store.drafts, cellKey(r.employee_id, date), r.day.entry?.id ?? null) } : null)} onOpen={() => setOpen({ id: r.employee_id, own: r.own })} onAssign={() => setAssign({ kind: "PERSON", id: r.employee_id, name: r.name })} />
                        ))}
                      </Card>
                    ))
                  )}
                </div>
                <Card title={t("attendanceRecords.rail.title")}>
                  <Button variant="secondary" onClick={() => go({ issues: true, detail: undefined })}>{t("attendanceRecords.rail.process", { count: b.marks.blocking + b.marks.decision })}</Button>
                  <ItemList
                    label={t("attendanceRecords.rail.groups")}
                    items={b.groups.filter((g) => g.marks.blocking > 0).map((g) => ({
                      key: `${g.workplace_id}-${g.unit_id}`,
                      text: t("attendanceRecords.rail.groupLine", { name: g.name, blocking: g.marks.blocking }),
                      end: (
                        g.rows.some((r) => r.day.marks.includes("NO_RECORD")) ? <Button size="sm" onClick={() => {
                          const result = fillSchedule(g.rows.map((r) => ({ key: cellKey(r.employee_id, date), planKind: r.day.plan.kind, entryId: r.day.entry?.id ?? null, own: r.own, closed: closed(r.month_state) })), store.drafts);
                          store.set(result.drafts);
                          setNote(t("attendanceRecords.fill.done", { filled: result.filled, ...result.skipped }));
                        }}>{t("attendanceRecords.rail.asScheduled")}</Button> : g.no_schedule > 0 ? <Link to="/attendance" search={{ tab: "day", date, wp: g.workplace_id ?? undefined, unit: g.unit_id ?? undefined, unscheduled: true }}>{t("attendanceRecords.unscheduled.view", { count: g.no_schedule })}</Link> : undefined
                      ),
                    }))}
                  />
                  <Button variant="ghost" onClick={() => window.print()}>{t("attendanceRecords.rail.print")}</Button>
                </Card>
              </div>
              {save && <SaveDock drafts={store.drafts} rows={rows} kindOf={kindOf} month={date.slice(0, 7)} onClose={() => setSave(false)} onFocusCell={() => setSave(false)} onSaved={(r, keys) => (store.saved(keys), setSave(false), setNote(t("attendanceRecords.receipt.saved", { saved: r.saved, opens: r.opens.blocking + r.opens.decision })))} />}
              {!save && open && <DayDock employeeId={open.id} date={date} own={open.own} onClose={() => setOpen(null)} onRewrite={() => setOpen(null)} onDone={(m) => (setOpen(null), setNote(m))} />}
            </div>
      {assign && <PersonScheduleSheet target={assign} onClose={() => setAssign(null)} onAssigned={(message) => (setAssign(null), setNote(message))} />}
    </>;
    }}</QueryState>
    </PageReadGate>
    </div>
  );
}
