import { useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { modChord } from "../../../lib/pure/keys";
import { todayKst } from "../../../lib/pure/today";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { Kbd } from "../../../ui/kbd/kbd";
import { Receipt } from "../../../ui/receipt/receipt";
import { at, rectIn, rectSize, type Range } from "../../../ui/sheet-grid/range";
import { monthGridPages, type GridRow, type SaveReceipt } from "../api";
import { shiftMonth } from "../domain/month";
import { cellKey, draftState, splitKey } from "../domain/grid";
import { suggestFix } from "../domain/grammar";
import { pageState } from "../domain/month-state";
import { dateText, monthText, refusalText } from "../present";
import { DayDock, type DayDockMode } from "./day-dock";
import { MonthConsoleView } from "./month-console-view";
import { extractOpenIssues, filterMonthRows, summarizeMonth, type MonthFilter, type OpenIssueRow } from "../domain/month-console-summary";
import { MonthGridView, type GridAct } from "./month-grid-view";
import { MonthStateBanner } from "./month-state-banner";
import { SaveDock } from "./save-dock";
import { PeriodStepper } from "./period-stepper";
import { ScopePicker } from "./scope-picker";
import { PersonScheduleSheet } from "./person-schedule-sheet";
import type { AssignTarget } from "./assign-sheet";
import { UndoBatchSheet } from "./undo-batch-sheet";
import { useDrafts } from "./use-drafts";
import { useOnline } from "../../../lib/react/use-online";
import { usePlanKinds } from "./use-plan-kinds";
import s from "./records.module.css";

const route = getRouteApi("/app/attendance");
const CAP = 10_000;
type Dock = { kind: "save" } | { kind: "day"; employeeId: string; date: string; own: boolean } | null;
const daysOf = (m: string) => Array.from({ length: new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate() }, (_, i) => `${m}-${String(i + 1).padStart(2, "0")}`);

/**
 * month timesheet (A3-grid, the default tab): people × days of one scope and month. Drafts stay in this tab until saved in
 * one transaction with one evidence (the save sheet, docked). The status line names a refused draft and offers the one
 * likely fix; the selection bar counts cells against the 10,000-cell save. A saved batch can be undone (batch undo) until
 * its month closes.
 */
export function MonthTab({ head }: { head?: ReactNode }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const month = search.month ?? todayKst().slice(0, 7);
  const days = useMemo(() => daysOf(month), [month]);
  const grid = useInfiniteQuery({ ...monthGridPages(month, search.wp, search.unit), placeholderData: keepPreviousData });
  const firstPage = grid.data?.pages[0];
  const rows: GridRow[] = useMemo(() => grid.data?.pages.flatMap((p) => p.rows) ?? [], [grid.data]);
  const total = firstPage?.people_total ?? 0;
  const workPatternSummary = firstPage?.work_pattern_summary ?? null;
  const serverSummary = firstPage?.summary;
  const monthState = useMemo(() => pageState(rows.map((r) => r.month_state)), [rows]);
  const store = useDrafts(`${month}:${search.wp ?? ""}:${search.unit ?? ""}`, rows);
  const online = useOnline();
  // Keep hook indices 0..5 stable for unit-test mocks.
  const [range, setRange] = useState<Range | null>(null);
  const [dock, setDock] = useState<Dock>(null);
  const [note, setNote] = useState<string | null>(null);
  const feedback = [note, store.problem && t(`attendanceRecords.drafts.${store.problem}`)].filter(Boolean).join(" · ");
  const [receipt, setReceipt] = useState<SaveReceipt | null>(null);
  const [undo, setUndo] = useState(false);
  const [assign, setAssign] = useState<AssignTarget | null>(null);
  const [filter, setFilter] = useState<MonthFilter>("all");
  const [dayMode, setDayMode] = useState<DayDockMode>("view");
  const go = (patch: Record<string, unknown>) => void navigate({ search: (x) => ({ ...x, ...patch }) });

  const drafts = Object.entries(store.drafts);
  const kindOf = usePlanKinds(rows, days);
  const bad = drafts.filter(([k, d]) => !draftState(d, kindOf(k)).ok);
  const size = rectSize(rectIn(range, { rows: rows.map((r) => r.employee_id), cols: days }));
  const focusKey = range ? cellKey(range.focus.row, range.focus.col) : null;
  const focusDraft = focusKey ? store.drafts[focusKey] : undefined;
  const focusState = focusDraft ? draftState(focusDraft, kindOf(focusKey!)) : null;
  const fix = focusDraft && focusState && !focusState.ok ? suggestFix(focusDraft.value) : null;
  const openDayDock = (employeeId: string, date: string, own: boolean) => {
    setDayMode("view");
    setDock({ kind: "day", employeeId, date, own });
  };
  const closeDock = () => {
    setDayMode("view");
    setDock(null);
  };
  const act = (a: GridAct) => {
    if (a.kind === "save") setDock({ kind: "save" });
    else if (a.kind === "month") go({ month: shiftMonth(month, a.step) });
    else if (a.kind === "note") setNote(a.message);
    else if (a.kind === "assign") setAssign({ kind: "PERSON", id: a.row.employee_id, name: a.row.name });
    else openDayDock(a.row.employee_id, days[a.day]!, a.row.own);
  };
  const focusCell = (key: string) => {
    const { employee_id, work_date } = splitKey(key);
    setRange(at(employee_id, work_date));
  };
  const saveWhy = !online ? t("attendanceRecords.save.offline") : null;
  const empty = grid.isSuccess && total === 0;
  const saveButton = (
    <Button variant={dock ? "secondary" : "primary"} disabled={!!saveWhy} onClick={() => setDock({ kind: "save" })}>
      {t("attendanceRecords.toolbar.save")} <Kbd keys={modChord("S")} />
    </Button>
  );

  const summary = useMemo(() => {
    const local = summarizeMonth(rows, total, days);
    if (!serverSummary) return local;
    return {
      ...local,
      scheduledDays: serverSummary.scheduled_days,
      weekdayHolidays: serverSummary.weekday_holidays,
      recognisedMinutes: serverSummary.recognised_minutes,
      outsideMinutes: serverSummary.outside_minutes,
      unapprovedMinutes: serverSummary.unapproved_minutes,
      blockingCount: serverSummary.blocking_count,
      decisionCount: serverSummary.decision_count,
      overtimePeopleCount: serverSummary.overtime_people_count,
      // Keep filterMonthRows(..., "issues") parity when rows include LATE/ABSENT info marks.
      issuePeopleCount: Math.max(serverSummary.issue_people_count, local.issuePeopleCount),
    };
  }, [rows, total, days, serverSummary]);
  const filteredRows = useMemo(() => filterMonthRows(rows, filter), [rows, filter]);
  const openIssues = useMemo(() => extractOpenIssues(rows), [rows]);
  const openIssue = (item: OpenIssueRow) => {
    setRange(at(item.employeeId, item.date));
    openDayDock(item.employeeId, item.date, item.own);
  };

  const notes = (
    <>
      {!online && <Banner tone="warn">{t("attendanceRecords.offline")}</Banner>}
      <MonthStateBanner state={monthState} month={month} />
      {focusDraft && focusState && !focusState.ok && (
        <Banner tone="danger" actions={fix ? <Button size="sm" onClick={() => store.put(focusKey!, { ...focusDraft, value: fix })}>{t("attendanceRecords.fix.use", { value: fix })}</Button> : undefined}>
          {t("attendanceRecords.status.refused", { value: focusDraft.value })} {refusalText(focusState.code)}
        </Banner>
      )}
      {feedback && <p className="muted" role="status">{feedback}</p>}
      {size.cells > 1 && (
        <p className={s.selection} role="status">
          {t(size.cells > CAP ? "attendanceRecords.selection.over" : "attendanceRecords.selection.count", { people: size.people, days: size.days, cells: size.cells })}
        </p>
      )}
      {receipt && (
        <Receipt
          state="recorded"
          message={t("attendanceRecords.receipt.saved", { saved: receipt.saved, opens: receipt.opens.blocking + receipt.opens.decision })}
          actions={<Button size="sm" variant="ghost" onClick={() => setUndo(true)}>{t("attendanceRecords.receipt.undo")}</Button>}
        />
      )}
    </>
  );

  const emptyBlock = search.wp || search.unit ? (
    <EmptyState title={t("attendanceRecords.empty.filteredTitle")} reason={t("attendanceRecords.empty.filteredReason")} actions={<Button onClick={() => go({ wp: undefined, unit: undefined })}>{t("attendanceRecords.empty.clear")}</Button>} />
  ) : (
    <EmptyState title={t("attendanceRecords.empty.title")} reason={t("attendanceRecords.empty.reason")} actions={<Link to="/attendance" search={{ tab: "schedule" }} className={buttonClass("primary")}>{t("attendanceRecords.empty.toSchedule")}</Link>} />
  );
  const noScheduleBanner = rows.length > 0 && rows.every((r) => r.cells.every((c) => c.plan_kind === "NO_SCHEDULE")) ? (
    <Banner tone="warn" actions={<Link to="/attendance" search={{ tab: "schedule" }}>{t("attendanceRecords.empty.toSchedule")}</Link>}>{t("attendanceRecords.noSchedule")}</Banner>
  ) : null;
  const moreButton = grid.hasNextPage ? (
    <Button onClick={() => void grid.fetchNextPage()} disabled={grid.isFetchingNextPage}>{t("attendanceRecords.more", { shown: rows.length, total })}</Button>
  ) : null;
  const overlays = (
    <>
      {undo && receipt && <UndoBatchSheet batchId={receipt.batch_id} saved={receipt.saved} month={month} onClose={() => setUndo(false)} onDone={(m) => (setUndo(false), setReceipt(null), setNote(m))} />}
      {assign && <PersonScheduleSheet target={assign} onClose={() => setAssign(null)} onAssigned={(message) => (setAssign(null), setNote(message))} />}
    </>
  );

  const dockRow = dock?.kind === "day" ? rows.find((r) => r.employee_id === dock.employeeId) : undefined;
  const dayDockTitle = dock?.kind === "day"
    ? dayMode === "correct" ? t("attendanceRecords.correct.title") : dayMode === "void" ? t("attendanceRecords.void.title") : t("attendanceRecords.day.title", { date: dateText(dock.date) })
    : "";
  const dayDockMeta = dock?.kind === "day" && dockRow
    ? dayMode === "view" ? `${dockRow.name} ${dockRow.employee_number ?? ""}`.trim() : `${dockRow.name} · ${dateText(dock.date)}`
    : undefined;
  const record = dock?.kind === "save" && drafts.length > 0
    ? {
        id: "save",
        label: t("attendanceRecords.save.title", { count: drafts.length }),
        title: t("attendanceRecords.save.title", { count: drafts.length }),
        meta: monthText(month),
        onClose: closeDock,
        children: <SaveDock variant="pane" drafts={store.drafts} rows={rows} kindOf={kindOf} month={month} onClose={closeDock} onFocusCell={focusCell} onSaved={(r, keys) => (store.saved(keys), closeDock(), setReceipt(r))} />,
      }
    : dock?.kind === "day"
      ? {
          id: `day:${dock.employeeId}:${dock.date}`,
          label: dayDockTitle,
          title: dayDockTitle,
          meta: dayDockMeta,
          onClose: closeDock,
          children: <DayDock variant="pane" employeeId={dock.employeeId} date={dock.date} own={dock.own} mode={dayMode} onModeChange={setDayMode} onClose={closeDock} onRewrite={closeDock} onDone={(m) => (closeDock(), setNote(m))} />,
        }
      : null;

  return (
    <MonthConsoleView
      grid={grid}
      month={month}
      wp={search.wp}
      empty={empty}
      rows={rows}
      filteredRows={filteredRows}
      total={total}
      days={days}
      monthState={monthState}
      filter={filter}
      onFilter={setFilter}
      summary={summary}
      workPatternSummary={workPatternSummary}
      openIssues={openIssues}
      draftCount={drafts.length}
      refusedDraftCount={bad.length}
      saveWhy={saveWhy}
      saveOpen={dock?.kind === "save"}
      onOpenSave={() => setDock({ kind: "save" })}
      onGo={go}
      onInspectIssue={openIssue}
      store={store}
      range={range}
      onRange={(r) => (setNote(null), setRange(r))}
      act={act}
      notes={notes}
      emptyBlock={emptyBlock}
      noScheduleBanner={noScheduleBanner}
      moreButton={moreButton}
      selectedDayKey={dock?.kind === "day" ? `${dock.employeeId}|${dock.date}` : undefined}
      record={record}
      overlays={overlays}
      baseline={() => (
        <div className={s.monthPage}>
          {head}
          <PageReadGate q={grid} own={refusalText} recovery={search.wp ? <ScopePicker value={search.wp} onChange={(wp) => go({ wp, unit: undefined })} /> : undefined}>
          {!empty && <div className={s.toolbar} role="toolbar" aria-label={t("attendanceRecords.toolbar.label")}>
            <ScopePicker value={search.wp} onChange={(wp) => go({ wp, unit: undefined })} />
            <PeriodStepper unit="month" value={month} onChange={month => go({ month })} />
            {drafts.length > 0 && !grid.error && <>
              <span role="status">{t("attendanceRecords.toolbar.unsaved", { count: drafts.length, refused: bad.length })}</span>
              {saveWhy ? <DisabledReason reason={saveWhy} control={() => saveButton} /> : saveButton}
            </>}
          </div>}
          <QueryState q={grid} own={refusalText} layout="grid">{() => <>
          {notes}
          <div className={s.monthLayout} data-docked={dock ? "" : undefined}>
            <div className={s.gridCol}>
              {!rows.length ? emptyBlock : (
                <>
                  <MonthGridView rows={rows} total={total} days={days} store={store} range={range} onRange={(r) => (setNote(null), setRange(r))} act={act} />
                  {noScheduleBanner}
                  {moreButton}
                </>
              )}
            </div>
            {dock?.kind === "save" && drafts.length > 0 && (
              <SaveDock drafts={store.drafts} rows={rows} kindOf={kindOf} month={month} onClose={closeDock} onFocusCell={focusCell} onSaved={(r, keys) => (store.saved(keys), closeDock(), setReceipt(r))} />
            )}
            {dock?.kind === "day" && (
              <DayDock employeeId={dock.employeeId} date={dock.date} own={dock.own} onClose={closeDock} onRewrite={closeDock} onDone={(m) => (closeDock(), setNote(m))} />
            )}
          </div>
          {overlays}
        </>}</QueryState>
        </PageReadGate>
        </div>
      )}
    />
  );
}
