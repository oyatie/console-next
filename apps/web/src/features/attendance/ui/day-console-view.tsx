// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { ATTENDANCE_MARK } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { useOnline } from "../../../lib/react/use-online";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Segmented } from "../../../ui/button/segmented";
import { addDays } from "../../../ui/date/days";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { Kbd } from "../../../ui/kbd/kbd";
import { PaneGrid } from "../../../ui/pane-grid/pane-grid";
import { PatternShell } from "../../../ui/patterns/pattern-shell";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { dayBoardQuery } from "../api";
import { baseOf, ledgerParts } from "../domain/grid";
import { pageState } from "../domain/month-state";
import { dateText, dayPaneHead, monthText, type DayDockMode } from "../present";
import type { AssignTarget } from "./assign-sheet";
import { AttendanceTabNav } from "./attendance-head";
import { DayBars } from "./day-bar";
import { DayConsoleRail, DayGroupSections, DayLedgerStats, DayOpenPaneBody, DaySavePaneBody } from "./day-console-rail";
import { DayDetail } from "./day-detail";
import { IssueGroups } from "./issue-groups";
import { MonthStateBanner } from "./month-state-banner";
import { PeriodStepper } from "./period-stepper";
import { PersonScheduleSheet } from "./person-schedule-sheet";
import { ScopePicker } from "./scope-picker";
import { useDrafts } from "./use-drafts";
import { usePlanKinds } from "./use-plan-kinds";
import s from "./attendance-console.module.css";

const SubstitutionsSheet = lazy(() => chunk(import("./substitutions-sheet")).then((m) => ({ default: m.SubstitutionsSheet })));

const route = getRouteApi("/app/attendance");

export function DayConsoleView({ baseline }: { baseline: () => React.ReactNode }) {
  const grammarHintId = useId();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const date = search.date ?? addDays(todayKst(), -1);
  const mark = ATTENDANCE_MARK.values.find(value => value === search.mark);
  const board = useQuery(
    dayBoardQuery(date, search.wp, search.unit, search.issues, search.unscheduled, search.detail ? "all" : undefined, mark),
  );
  const rows = useMemo(() => board.data?.groups.flatMap(g => g.rows) ?? [], [board.data]);
  const kindOf = usePlanKinds(rows, date);
  const store = useDrafts(`day:${date}`, rows);
  const online = useOnline();
  const [save, setSave] = useState(false);
  const [open, setOpen] = useState<{ id: string; own: boolean; mode: DayDockMode } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [assign, setAssign] = useState<AssignTarget | null>(null);
  const [subsOpen, setSubsOpen] = useState(false);
  const go = (patch: Record<string, unknown>) => void navigate({ search: x => ({ ...x, ...patch }) });

  const drafts = Object.keys(store.drafts).length;
  const feedback = [
    drafts > 0 && t("attendanceRecords.toolbar.unsaved", { count: drafts, refused: 0 }),
    note,
    store.problem && t(`attendanceRecords.drafts.${store.problem}`),
  ]
    .filter(Boolean)
    .join(" · ");
  const saveWhy = !online ? t("attendanceRecords.save.offline") : null;
  const empty = board.data?.ledger.people === 0;
  const filterValue = search.unscheduled ? "unscheduled" : search.issues ? "issues" : "all";
  const modeValue = search.detail ? "detail" : "simple";

  const saveButton = (
    <Button size="sm" variant="primary" className={s.nowrap} onClick={() => setSave(true)}>
      {t("attendanceRecords.toolbar.save")} <Kbd keys="⌘S" />
    </Button>
  );

  return (
    <PatternShell
      pattern="worklist"
      floorplan="P-03"
      q={board}
      tabs={<AttendanceTabNav tab="day" />}
      queryLayout="grid"
      detailActive={Boolean(save || open)}
      head={{
        title: t("attendance.title"),
        titleId: "attendance-day-title",
        filters: !empty ? (
          <div className={s.filterPair}>
            <PeriodStepper unit="day" variant="boxed" showCurrent={false} value={date} onChange={nextDate => go({ date: nextDate })} />
            <ScopePicker compact value={search.wp} onChange={wp => go({ wp, unit: undefined })} />
            <Segmented
              label={t("attendance.dayConsole.filter.label")}
              size="sm"
              value={filterValue}
              onChange={val =>
                go(
                  val === "issues"
                    ? { issues: true, unscheduled: undefined, mark: undefined }
                    : val === "unscheduled"
                      ? { unscheduled: true, issues: undefined, mark: undefined }
                      : { issues: undefined, unscheduled: undefined, mark: undefined },
                )
              }
              items={[
                { id: "all", label: t("home.inbox.filter.all") },
                { id: "issues", label: t("attendanceRecords.board.issuesOnly") },
                { id: "unscheduled", label: t("attendanceRecords.unscheduled.only") },
              ]}
            />
            <Segmented
              label={t("attendance.dayConsole.mode.label")}
              size="sm"
              value={modeValue}
              onChange={val => go({ detail: val === "detail" ? true : undefined })}
              items={[
                { id: "simple", label: t("attendanceRecords.board.simple") },
                { id: "detail", label: t("attendanceRecords.board.detail") },
              ]}
            />
          </div>
        ) : undefined,
        actions: !empty ? (
          <div className={s.scheduleTools}>
            {drafts > 0 && !board.error ? (
              saveWhy ? (
                <DisabledReason reason={saveWhy} control={p => <Button {...p} size="sm" variant="primary" className={s.nowrap}>{t("attendanceRecords.toolbar.save")}</Button>} />
              ) : (
                saveButton
              )
            ) : null}
            <Button size="sm" variant="secondary" className={s.nowrap} onClick={() => setSubsOpen(true)}>
              {t("attendance.sub.openButton")}
            </Button>
            <Button size="sm" variant="secondary" className={s.nowrap} onClick={() => window.print()}>
              {t("attendance.dayConsole.print")}
            </Button>
          </div>
        ) : undefined,
      }}
      overlays={
        assign ? (
          <PersonScheduleSheet
            target={assign}
            onClose={() => setAssign(null)}
            onAssigned={message => (setAssign(null), setNote(message))}
          />
        ) : subsOpen ? (
          <Suspense fallback={null}>
            <SubstitutionsSheet date={date} branchId={search.wp} onClose={() => setSubsOpen(false)} />
          </Suspense>
        ) : undefined
      }
      statusSegments={
        board.data
          ? [
              { id: "summary", content: t("attendance.dayConsole.status.summary", { people: board.data.ledger.people, date: dateText(date) }) },
              ...(drafts > 0 ? [{ id: "drafts", tone: "attention" as const, content: t("attendanceRecords.toolbar.unsaved", { count: drafts, refused: 0 }) }] : []),
            ]
          : undefined
      }
      baseline={baseline}
    >
      {() => {
        const b = board.data!;
        const ledger = ledgerParts(b.ledger);
        const openCount = b.marks.blocking + b.marks.decision;
        const blockingGroups = b.groups.filter(g => g.marks.blocking > 0);
        return (
          <div className={s.dayMain}>
            <DayLedgerStats ledger={b.ledger} />

            <PaneGrid
              main={
                <div className={s.dayGroups}>
                  {feedback ? <div role="status" aria-live="polite" className="muted t-sm">{feedback}</div> : null}
                  <MonthStateBanner state={pageState(b.groups.flatMap(g => g.rows.map(r => r.month_state)))} month={date.slice(0, 7)} />
                  {!b.judged && <RecordBannerBand tone="neutral">{t("attendanceRecords.board.notJudged")}</RecordBannerBand>}
                  {!ledger.adds && <RecordBannerBand tone="warn">{t("attendanceRecords.board.ledgerGap")}</RecordBannerBand>}
                  {b.issue_groups && b.issue_groups.some(g => g.count > 0) ? (
                    <IssueGroups
                      groups={b.issue_groups}
                      selected={mark}
                      onSelect={selectedMark => go({ mark: selectedMark, issues: true, unscheduled: undefined })}
                    />
                  ) : null}
                  {b.groups.length > 0 ? (
                    <div className="muted t-xs">
                      <strong>{t("attendanceRecords.grammar.label")}</strong> · <bdi id={grammarHintId}>{t("attendanceRecords.grammar.hint")}</bdi>
                    </div>
                  ) : null}
                  {!b.groups.length ? (
                    search.issues || search.unscheduled ? (
                      <EmptyState
                        title={t("attendanceRecords.empty.filteredTitle")}
                        reason={t("attendanceRecords.board.noIssues")}
                        actions={
                          <Button onClick={() => go({ issues: undefined, mark: undefined, unscheduled: undefined, wp: undefined, unit: undefined })}>
                            {t("attendanceRecords.empty.clear")}
                          </Button>
                        }
                      />
                    ) : (
                      <EmptyState
                        title={t("attendanceRecords.empty.title")}
                        reason={t("attendanceRecords.empty.reason")}
                        actions={
                          <Link to="/attendance" search={{ tab: "schedule" }} className={buttonClass("primary")}>
                            {t("attendanceRecords.empty.toSchedule")}
                          </Link>
                        }
                      />
                    )
                  ) : search.detail ? (
                    <DayDetail
                      board={b}
                      store={store}
                      grammarHintId={grammarHintId}
                      onNote={setNote}
                      onAssign={r => setAssign({ kind: "PERSON", id: r.employee_id, name: r.name })}
                    />
                  ) : (
                    <DayBars days={rows.map(r => r.day)} labels={rows.map(r => `${r.name} ${r.employee_number ?? ""}`)}>
                      <DayGroupSections
                        groups={b.groups}
                        date={date}
                        grammarHintId={grammarHintId}
                        drafts={store.drafts}
                        onPutDraft={(key, value, entryId) =>
                          store.put(key, value ? { value, base: baseOf(store.drafts, key, entryId) } : null)
                        }
                        onExpandUnit={unit => go({ unit })}
                        onOpenRow={r => setOpen({ id: r.employee_id, own: r.own, mode: "view" })}
                        onAssignRow={r => setAssign({ kind: "PERSON", id: r.employee_id, name: r.name })}
                      />
                    </DayBars>
                  )}
                </div>
              }
              bottom={
                <DayConsoleRail
                  peopleCount={b.ledger.people}
                  openCount={openCount}
                  blockingGroups={blockingGroups}
                  date={date}
                  drafts={store.drafts}
                  onSetDrafts={store.set}
                  onSetNote={setNote}
                  onGoIssues={() => go({ issues: true, detail: undefined })}
                />
              }
              record={
                save
                  ? {
                      id: "day-save",
                      label: t("attendanceRecords.save.title", { count: drafts }),
                      title: t("attendanceRecords.save.title", { count: drafts }),
                      meta: monthText(date.slice(0, 7)),
                      onClose: () => setSave(false),
                      children: (
                        <DaySavePaneBody
                          drafts={store.drafts}
                          rows={rows}
                          kindOf={kindOf}
                          month={date.slice(0, 7)}
                          onClose={() => setSave(false)}
                          onSaved={(r, keys) => {
                            store.saved(keys);
                            setSave(false);
                            setNote(t("attendanceRecords.receipt.saved", { saved: r.saved, opens: r.opens.blocking + r.opens.decision }));
                          }}
                        />
                      ),
                    }
                  : open
                    ? {
                        id: open.id,
                        ...dayPaneHead(open.mode, date, rows.find(r => r.employee_id === open.id)),
                        onClose: () => setOpen(null),
                        children: (
                          <DayOpenPaneBody
                            employeeId={open.id}
                            date={date}
                            own={open.own}
                            mode={open.mode}
                            onModeChange={mode => setOpen(o => o && { ...o, mode })}
                            onClose={() => setOpen(null)}
                            onSetNote={setNote}
                          />
                        ),
                      }
                    : null
              }
            />
          </div>
        );
      }}
    </PatternShell>
  );
}
