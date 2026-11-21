// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, type ReactNode } from "react";
import { t } from "@console/i18n";
import { Badge } from "../../../ui/badge/badge";
import { Button } from "../../../ui/button/button";
import { Segmented } from "../../../ui/button/segmented";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { Kbd } from "../../../ui/kbd/kbd";
import { StatRow } from "../../../ui/key-value/key-value";
import { MonthGridPattern } from "../../../ui/patterns/month-grid";
import type { GridFooterRow } from "../../../ui/person-day-grid/person-day-grid";
import type { SidePaneSpec } from "../../../ui/pane-grid/pane-grid-side";
import type { Range } from "../../../ui/sheet-grid/range";
import type { GridRow } from "../api";
import { hours } from "../domain/day";
import { duration } from "../domain/minutes";
import type { PageState } from "../domain/month-state";
import { AttendanceTabNav } from "./attendance-head";
import { MonthConsoleBottom } from "./month-console-bottom";
import { summarizeDailyFooter, type MonthFilter, type OpenIssueRow, type summarizeMonth } from "../domain/month-console-summary";
import { MonthGridView, type GridAct } from "./month-grid-view";
import { PeriodStepper } from "./period-stepper";
import { ScopePicker } from "./scope-picker";
import type { useDrafts } from "./use-drafts";
import s from "./records.module.css";
import type { ReadState } from "../../../lib/react/query-view";

type Props = {
  grid: ReadState;
  month: string;
  wp?: string;
  empty: boolean;
  rows: readonly GridRow[];
  filteredRows: readonly GridRow[];
  total: number;
  days: readonly string[];
  monthState: PageState;
  filter: MonthFilter;
  onFilter: (f: MonthFilter) => void;
  summary: ReturnType<typeof summarizeMonth>;
  openIssues: readonly OpenIssueRow[];
  draftCount: number;
  refusedDraftCount: number;
  saveWhy: string | null;
  saveOpen: boolean;
  onOpenSave: () => void;
  onGo: (patch: Record<string, unknown>) => void;
  onInspectIssue: (item: OpenIssueRow) => void;
  store: ReturnType<typeof useDrafts>;
  range: Range | null;
  onRange: (r: Range) => void;
  act: (a: GridAct) => void;
  notes: ReactNode;
  emptyBlock: ReactNode;
  noScheduleBanner: ReactNode;
  moreButton: ReactNode;
  selectedDayKey?: string;
  record: SidePaneSpec | null;
  overlays: ReactNode;
  baseline: () => ReactNode;
};

/** Console `P5` (`MonthGridPattern`) presentation for `/attendance` Month, preserving `baseline` via fallback. */
export function MonthConsoleView({
  grid,
  month,
  wp,
  empty,
  rows,
  filteredRows,
  total,
  days,
  monthState,
  filter,
  onFilter,
  summary,
  openIssues,
  draftCount,
  refusedDraftCount,
  saveWhy,
  saveOpen,
  onOpenSave,
  onGo,
  onInspectIssue,
  store,
  range,
  onRange,
  act,
  notes,
  emptyBlock,
  noScheduleBanner,
  moreButton,
  selectedDayKey,
  record,
  overlays,
  baseline,
}: Props) {
  const totalIssues = summary.blockingCount + summary.decisionCount;
  const closeWhy = summary.blockingCount > 0
    ? t("attendance.monthConsole.closeBlocked.blocking", { count: summary.blockingCount })
    : monthState.state === "CLOSED"
      ? t("attendance.monthConsole.closeBlocked.closed")
      : null;
  const focusedRow = range ? rows.find((r) => r.employee_id === range.focus.row) : undefined;
  const activeRow = focusedRow ?? filteredRows[0] ?? rows[0];
  const dailyFooter = useMemo(() => summarizeDailyFooter(filteredRows, days.length), [filteredRows, days.length]);
  const footerRows: readonly GridFooterRow[] = useMemo(() => {
    if (filteredRows.length === 0) return [];
    const hasApprovedOt = dailyFooter.approvedOtMinutes.some((m) => m > 0);
    return [
      {
        key: "worked-headcount",
        label: t("attendance.monthConsole.grid.footer.workedHeadcount"),
        day: (c) => (dailyFooter.workedCount[c] ? dailyFooter.workedCount[c] : null),
        tail: [
          dailyFooter.recognisedMinutes ? duration(dailyFooter.recognisedMinutes) : "–",
          dailyFooter.outsideMinutes ? duration(dailyFooter.outsideMinutes) : "–",
          dailyFooter.unapprovedMinutes ? duration(dailyFooter.unapprovedMinutes) : "–",
          dailyFooter.issueCount > 0 ? t("attendance.count", { count: dailyFooter.issueCount }) : "–",
        ],
      },
      ...(hasApprovedOt
        ? [
            {
              key: "approved-ot",
              label: t("attendance.monthConsole.grid.footer.approvedOvertime"),
              day: (c: number) => (dailyFooter.approvedOtMinutes[c] ? hours(dailyFooter.approvedOtMinutes[c]!) : null),
              tail: [null, null, null, null],
            },
          ]
        : []),
    ];
  }, [filteredRows.length, dailyFooter]);
  const consoleSaveButton = (
    <Button size="sm" variant={saveOpen ? "secondary" : "primary"} className={s.nowrap} disabled={!!saveWhy} onClick={onOpenSave}>
      {t("attendanceRecords.toolbar.save")} <Kbd keys="⌘S" />
    </Button>
  );

  return (
    <MonthGridPattern
      q={grid}
      tabs={<AttendanceTabNav tab="month" />}
      head={{
        title: t("attendance.title"),
        titleId: "attendance-month-title",
        filters: !empty ? (
          <>
            <div className={s.filterPair}>
              <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={month} onChange={(m) => onGo({ month: m })} />
              <ScopePicker compact value={wp} onChange={(nextWp) => onGo({ wp: nextWp, unit: undefined })} />
            </div>
            <Segmented
              label={t("attendance.monthConsole.filter.label")}
              size="sm"
              value={filter}
              onChange={onFilter}
              items={[
                { id: "all", label: t("home.inbox.filter.all") },
                { id: "issues", label: t("attendance.monthConsole.filter.issues"), count: summary.issuePeopleCount || undefined, tone: summary.issuePeopleCount > 0 ? "warn" : undefined },
                { id: "overtime", label: t("attendance.monthConsole.filter.overtime"), count: summary.overtimePeopleCount || undefined },
              ]}
            />
          </>
        ) : undefined,
        tools: !empty ? (
          <div className={s.headTools}>
            {draftCount > 0 && !grid.error && (
              <>
                <bdi role="status" className={`t-xs muted ${s.nowrap}`}>{t("attendanceRecords.toolbar.unsaved", { count: draftCount, refused: refusedDraftCount })}</bdi>
                {saveWhy ? <DisabledReason layout="disclosure" reason={saveWhy} control={() => consoleSaveButton} /> : consoleSaveButton}
              </>
            )}
            {closeWhy ? (
              <DisabledReason
                layout="disclosure"
                reason={closeWhy}
                control={(dp) => (
                  <Button {...dp} size="sm" variant="secondary" className={[dp.className, s.nowrap].filter(Boolean).join(" ")}>
                    {t("attendance.tab.close")}
                  </Button>
                )}
              />
            ) : (
              <Button size="sm" variant="secondary" className={s.nowrap} onClick={() => onGo({ tab: "close" })}>
                {t("attendance.tab.close")}
              </Button>
            )}
          </div>
        ) : undefined,
        actions: !empty ? (
          <div className={s.headActions}>
            <Chip tone={monthState.state === "CLOSED" ? "info" : monthState.state === "REOPENED" ? "warn" : "neutral"} className={s.nowrap}>
              {monthState.state === "CLOSED"
                ? t("attendance.close.closed")
                : monthState.state === "REOPENED"
                  ? t("attendanceRecords.card.reopenedOpenEnded")
                  : t("attendance.monthConsole.closeStatus.open")}
            </Chip>
            {openIssues.length > 0 && (
              <Button size="sm" variant="primary" className={s.nowrap} onClick={() => onInspectIssue(openIssues[0]!)}>
                {t("attendance.monthConsole.actions.reviewIssues")} <Badge count={openIssues.length} tone="inverse" />
              </Button>
            )}
          </div>
        ) : undefined,
      }}
      summary={
        rows.length > 0 ? (
          <StatRow
            label={t("attendance.title")}
            items={[
              { key: "scope", label: t("attendance.monthConsole.summary.scope"), value: t("attendance.people", { count: summary.total }) },
              { key: "scheduled", label: t("attendanceRecords.card.scheduledDays"), value: t("attendanceRecords.card.days", { count: summary.scheduledDays }) },
              { key: "holidays", label: t("attendance.monthConsole.summary.weekdayHolidays"), value: t("attendanceRecords.card.days", { count: summary.weekdayHolidays }) },
              { key: "recognised", label: t("attendanceRecords.total.recognised"), value: summary.recognisedMinutes ? duration(summary.recognisedMinutes) : "–" },
              {
                key: "outside",
                label: t("attendanceRecords.total.approved"),
                value: summary.outsideMinutes ? duration(summary.outsideMinutes) : "–",
                meta: summary.unapprovedMinutes > 0 ? t("attendance.monthConsole.summary.unapprovedMeta", { duration: duration(summary.unapprovedMinutes) }) : undefined,
              },
              {
                key: "issues",
                label: t("attendance.monthConsole.summary.openIssues"),
                value: t("attendance.count", { count: openIssues.length }),
                meta: totalIssues > 0 ? t("attendance.monthConsole.summary.issueMeta", { blocking: summary.blockingCount, decision: summary.decisionCount }) : undefined,
                tone: summary.blockingCount > 0 ? "danger" : openIssues.length > 0 ? "warn" : undefined,
              },
            ]}
          />
        ) : undefined
      }
      notes={notes}
      grid={
        !rows.length ? emptyBlock : !filteredRows.length ? (
          <EmptyState title={t("attendanceRecords.empty.filteredTitle")} reason={t("attendanceRecords.empty.filteredReason")} actions={<Button onClick={() => onFilter("all")}>{t("attendanceRecords.empty.clear")}</Button>} />
        ) : (
          <>
            <MonthGridView
              rows={filteredRows}
              total={total}
              days={days}
              store={store}
              range={range}
              onRange={onRange}
              act={act}
              consoleOrder
              activeRowId={activeRow?.employee_id}
              tailGroupHeader={t("attendance.monthConsole.grid.tailGroup")}
              footerRows={footerRows}
            />
            {noScheduleBanner}
            {moreButton}
          </>
        )
      }
      bottom={rows.length > 0 ? <MonthConsoleBottom issues={openIssues} selectedKey={selectedDayKey} onInspect={onInspectIssue} /> : undefined}
      record={record}
      overlays={overlays}
      statusSegments={rows.length > 0 ? [
        { id: "scope", content: t("attendance.monthConsole.status.scopeSummary", { people: summary.total, days: days.length }) },
        ...(activeRow ? [{ id: "selected", tone: "strong" as const, content: t("attendance.monthConsole.status.selected", { name: activeRow.name, code: activeRow.employee_number ?? "", recognised: activeRow.totals.recognised ? duration(activeRow.totals.recognised) : "–" }) }] : []),
        ...(openIssues.length > 0 ? [{ id: "issues", tone: "attention" as const, content: t("attendance.monthConsole.status.issues", { count: openIssues.length }) }] : []),
      ] : undefined}
      baseline={baseline}
    />
  );
}
