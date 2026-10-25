import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { failureText } from "../../../lib/refusal";
import { todayKst } from "../../../lib/pure/today";
import { Banner } from "../../../ui/banner/banner";
import { Button, IconButton } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { Kbd } from "../../../ui/kbd/kbd";
import { Receipt } from "../../../ui/receipt/receipt";
import { at, rectIn, rectSize, type Range } from "../../../ui/person-day-grid/range";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import { monthGridPages, type GridRow, type SaveReceipt } from "../api";
import { cellKey, draftState, splitKey } from "../domain/grid";
import { suggestFix } from "../domain/grammar";
import { pageState } from "../domain/month-state";
import { monthText, refusalText } from "../present";
import { DayDock } from "./day-dock";
import { MonthGridView, type GridAct } from "./month-grid-view";
import { MonthStateBanner } from "./month-state-banner";
import { SaveDock } from "./save-dock";
import { ScopePicker } from "./scope-picker";
import { PersonScheduleSheet } from "./person-schedule-sheet";
import type { AssignTarget } from "./assign-sheet";
import { UndoBatchSheet } from "./undo-batch-sheet";
import { useDrafts } from "./use-drafts";
import { useOnline } from "./use-online";
import { usePlanKinds } from "./use-plan-kinds";
import s from "./records.module.css";

const route = getRouteApi("/app/attendance");
const CAP = 10_000;
type Dock = { kind: "save" } | { kind: "day"; employeeId: string; date: string; own: boolean } | null;
const stepMonth = (m: string, by: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const daysOf = (m: string) => Array.from({ length: new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate() }, (_, i) => `${m}-${String(i + 1).padStart(2, "0")}`);

/**
 * month timesheet (A3-grid, the default tab): people × days of one scope and month. Drafts stay in this tab until saved in
 * one transaction with one evidence (the save sheet, docked). The status line names a refused draft and offers the one
 * likely fix; the selection bar counts cells against the 10,000-cell save. A saved batch can be undone (batch undo) until
 * its month closes.
 */
export function MonthTab() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const month = search.month ?? todayKst().slice(0, 7);
  const days = useMemo(() => daysOf(month), [month]);
  const grid = useInfiniteQuery(monthGridPages(month, search.wp, search.unit));
  const rows: GridRow[] = useMemo(() => grid.data?.pages.flatMap((p) => p.rows) ?? [], [grid.data]);
  const total = grid.data?.pages[0]?.people_total ?? 0;
  const monthState = useMemo(() => pageState(rows.map((r) => r.month_state)), [rows]);
  const store = useDrafts(`${month}:${search.wp ?? ""}:${search.unit ?? ""}`);
  const online = useOnline();
  const [range, setRange] = useState<Range | null>(null);
  const [dock, setDock] = useState<Dock>(null);
  const [note, setNote] = useState<string | null>(null);
  const feedback = [note, store.problem && t(`attendanceRecords.drafts.${store.problem}`)].filter(Boolean).join(" · ");
  const [receipt, setReceipt] = useState<SaveReceipt | null>(null);
  const [undo, setUndo] = useState(false);
  const [assign, setAssign] = useState<AssignTarget | null>(null);
  const go = (patch: Record<string, unknown>) => void navigate({ search: (x) => ({ ...x, ...patch }) });

  const drafts = Object.entries(store.drafts);
  const kindOf = usePlanKinds(rows, days);
  const bad = drafts.filter(([k, d]) => !draftState(d, kindOf(k)).ok);
  const size = rectSize(rectIn(range, { rows: rows.map((r) => r.employee_id), cols: days }));
  const focusKey = range ? cellKey(range.focus.row, range.focus.col) : null;
  const focusDraft = focusKey ? store.drafts[focusKey] : undefined;
  const focusState = focusDraft ? draftState(focusDraft, kindOf(focusKey!)) : null;
  const fix = focusDraft && focusState && !focusState.ok ? suggestFix(focusDraft.value) : null;
  const act = (a: GridAct) => {
    if (a.kind === "save") setDock({ kind: "save" });
    else if (a.kind === "month") go({ month: stepMonth(month, a.step) });
    else if (a.kind === "note") setNote(a.message);
    else if (a.kind === "assign") setAssign({ kind: "PERSON", id: a.row.employee_id, name: a.row.name });
    else setDock({ kind: "day", employeeId: a.row.employee_id, date: days[a.day]!, own: a.row.own });
  };
  const focusCell = (key: string) => {
    const { employee_id, work_date } = splitKey(key);
    setRange(at(employee_id, work_date));
  };
  const saveWhy = !online ? t("attendanceRecords.save.offline") : !drafts.length ? t("attendanceRecords.save.nothing") : null;
  const saveButton = (
    <Button variant={dock ? "secondary" : "primary"} disabled={!!saveWhy} onClick={() => setDock({ kind: "save" })}>
      {t("attendanceRecords.toolbar.save")} <Kbd keys="⌘S" />
    </Button>
  );

  return (
    <div className={s.monthPage}>
      <div className={s.toolbar} role="toolbar" aria-label={t("attendanceRecords.toolbar.label")}>
        <ScopePicker value={search.wp} onChange={(wp) => go({ wp, unit: undefined })} />
        <div className={s.stepper}>
          <IconButton size="sm" label={t("attendanceRecords.toolbar.prevMonth")} onClick={() => go({ month: stepMonth(month, -1) })}><ChevronLeft size={16} aria-hidden /></IconButton>
          <span className={s.stepText}>{monthText(month)}</span>
          <IconButton size="sm" label={t("attendanceRecords.toolbar.nextMonth")} onClick={() => go({ month: stepMonth(month, 1) })}><ChevronRight size={16} aria-hidden /></IconButton>
        </div>
        <span role="status">{t("attendanceRecords.toolbar.unsaved", { count: drafts.length, refused: bad.length })}</span>
        {saveWhy ? <DisabledReason reason={saveWhy} control={() => saveButton} /> : saveButton}
        <DisabledReason reason={t("attendanceRecords.toolbar.approvalLater")} control={(p) => <Button {...p}>{t("attendanceRecords.toolbar.approval")} <Kbd keys="⌘ Shift O" /></Button>} />
      </div>
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
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setUndo(true)}>{t("attendanceRecords.receipt.undo")}</Button>
              <DisabledReason reason={t("attendanceRecords.receipt.queueLater")} control={(p) => <Button {...p} size="sm" variant="ghost">{t("attendanceRecords.receipt.queue")}</Button>} />
            </>
          }
        />
      )}
      <div className={s.monthLayout} data-docked={dock ? "" : undefined}>
        <div className={s.gridCol}>
          {grid.isPending ? (
            <Skeleton bones={["row", "row", "row", "row", "row", "row"]} label={t("attendanceRecords.loading")} />
          ) : grid.isError && !rows.length ? (
            <EmptyState title={t("attendanceRecords.error.title")} reason={<>{failureText(grid.error, refusalText)} · {t("attendanceRecords.error.reason")}</>} alert actions={<Button onClick={() => void grid.refetch()}>{t("attendanceRecords.error.retry")}</Button>} />
          ) : !rows.length ? (
            search.wp || search.unit ? (
              <EmptyState title={t("attendanceRecords.empty.filteredTitle")} reason={t("attendanceRecords.empty.filteredReason")} actions={<Button onClick={() => go({ wp: undefined, unit: undefined })}>{t("attendanceRecords.empty.clear")}</Button>} />
            ) : (
              <EmptyState title={t("attendanceRecords.empty.title")} reason={t("attendanceRecords.empty.reason")} actions={<Link to="/attendance" search={{ tab: "schedule" }}>{t("attendanceRecords.empty.toSchedule")}</Link>} />
            )
          ) : (
            <>
              {rows.every((r) => r.cells.every((c) => c.plan_kind === "NO_SCHEDULE")) && (
                <Banner tone="warn" actions={<Link to="/attendance" search={{ tab: "schedule" }}>{t("attendanceRecords.empty.toSchedule")}</Link>}>{t("attendanceRecords.noSchedule")}</Banner>
              )}
              <MonthGridView rows={rows} total={total} days={days} store={store} range={range} onRange={(r) => (setNote(null), setRange(r))} act={act} />
              {grid.hasNextPage && <Button onClick={() => void grid.fetchNextPage()} disabled={grid.isFetchingNextPage}>{t("attendanceRecords.more", { shown: rows.length, total })}</Button>}
            </>
          )}
        </div>
        {dock?.kind === "save" && (
          <SaveDock drafts={store.drafts} rows={rows} kindOf={kindOf} month={month} onClose={() => setDock(null)} onFocusCell={focusCell} onSaved={(r, keys) => (store.saved(keys), setDock(null), setReceipt(r))} />
        )}
        {dock?.kind === "day" && (
          <DayDock employeeId={dock.employeeId} date={dock.date} own={dock.own} onClose={() => setDock(null)} onRewrite={() => setDock(null)} onDone={(m) => (setDock(null), setNote(m))} />
        )}
      </div>
      {undo && receipt && <UndoBatchSheet batchId={receipt.batch_id} saved={receipt.saved} month={month} onClose={() => setUndo(false)} onDone={(m) => (setUndo(false), setReceipt(null), setNote(m))} />}
      {assign && <PersonScheduleSheet target={assign} onClose={() => setAssign(null)} onAssigned={(message) => (setAssign(null), setNote(message))} />}
    </div>
  );
}
