// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { chunk } from "../../../lib/chunk-guard";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { readGroup } from "../../../lib/react/query-view";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { branchesQuery } from "../../../reference/org/api";
import { Chip } from "../../../ui/chip";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { closesQuery, preflightClose, type AttendanceMonthCloseItem, type ClosePreflight } from "../api";
import { AttendanceTabNav } from "./attendance-head";
import { useAttendancePhaseLine } from "./use-attendance-phase-line";
import { CloseConsoleActions } from "./close-console-actions";
import { PeriodStepper } from "./period-stepper";
import { ScopePicker } from "./scope-picker";
import s from "./attendance-console.module.css";

const CloseConfirmSheet = lazy(() => chunk(import("./close-console-sheets")).then((m) => ({ default: m.CloseConfirmSheet })));
const CloseAmendSheet = lazy(() => chunk(import("./close-console-sheets")).then((m) => ({ default: m.CloseAmendSheet })));

const route = getRouteApi("/app/attendance");

export function CloseConsoleView({ baseline }: { baseline: () => React.ReactNode }) {
  const isDesktop = useIsDesktop();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const month = search.month ?? (search.date ?? todayKst()).slice(0, 7);
  const board = useQuery(closesQuery(month, search.wp));
  const branches = useQuery(branchesQuery);
  const [selectedScope, setSelectedScope] = useState<string>();
  const [dismissedAuto, setDismissedAuto] = useState(false);
  const [preflightByScope, setPreflightByScope] = useState<Record<string, ClosePreflight>>({});
  const [sheet, setSheet] = useState<"confirm" | "amend" | null>(null);
  const go = (patch: Record<string, unknown>) => void navigate({ search: prev => ({ ...prev, ...patch }) });

  const combined = readGroup([board, branches]);
  const items = board.data?.items ?? [];
  const workplaceItems = items.filter(row => row.branch_scope !== "org");
  const displayItems = workplaceItems.length > 0 ? workplaceItems : items;
  const places = branches.data ?? [];
  const placeName = (scope: string) =>
    scope === "org"
      ? t("attendanceRecords.scope.allUnknown")
      : places.find(place => place.id === scope)?.name ?? t("attendance.close.unavailable");

  const effectiveSelectedScope = selectedScope ?? (isDesktop && !dismissedAuto ? displayItems[0]?.branch_scope : undefined);
  const selectedRow = displayItems.find(r => r.branch_scope === effectiveSelectedScope);
  const preflightKey = selectedRow ? `${month}:${selectedRow.branch_scope}` : "";
  const activePreflight = preflightKey ? (preflightByScope[preflightKey] ?? null) : null;

  const runPreflight = useCommand({
    run: async (branchScope: string) => {
      const res = await preflightClose(month, branchScope);
      setPreflightByScope((prev) => ({ ...prev, [`${month}:${branchScope}`]: res }));
      return res;
    },
  });

  const openConfirm = async () => {
    if (!selectedRow) return;
    if (!activePreflight) {
      try {
        await runPreflight.mutateAsync(selectedRow.branch_scope);
      } catch {
        return;
      }
    }
    setSheet("confirm");
  };

  const hasLocks = displayItems.some(row => row.close?.period_lock_id);
  const closedCount = displayItems.filter(r => r.closed).length;
  const openCount = displayItems.length - closedCount;
  const totalOpenExceptions = displayItems.reduce((sum, r) => sum + r.open_exceptions, 0);
  const totalPendingLeave = displayItems.reduce((sum, r) => sum + r.pending_leave, 0);

  const phaseLine = useAttendancePhaseLine();
  return (
    <ListRecord
      q={combined}
      tabs={<AttendanceTabNav tab="close" />}
      head={{
        title: t("attendance.title"),
        titleId: "attendance-close-title",
        meta: phaseLine,
      }}
      filters={
        <div className={s.filterPair}>
          <PeriodStepper unit="month" variant="boxed" value={month} onChange={nextMonth => go({ month: nextMonth })} />
          <ScopePicker compact value={search.wp} onChange={wp => go({ wp, unit: undefined })} />
        </div>
      }
      stats={
        displayItems.length > 0 ? (
          <StatRow
            label={t("attendance.tab.close")}
            items={[
              { key: "total", label: t("attendance.close.stat.total"), value: displayItems.length },
              { key: "closed", label: t("attendance.close.stat.closed"), value: closedCount, tone: "ok" },
              { key: "open", label: t("attendance.close.stat.open"), value: openCount, tone: openCount > 0 ? "warn" : undefined },
              { key: "issues", label: t("attendance.tab.issues"), value: totalOpenExceptions, tone: totalOpenExceptions > 0 ? "danger" : undefined },
              { key: "leave", label: t("attendance.close.pendingLeave"), value: totalPendingLeave },
            ]}
          />
        ) : undefined
      }
      list={
        <div className={s.tableWrap}>
          <LongTable<AttendanceMonthCloseItem>
            label={t("attendance.tab.close")}
            rows={displayItems}
            rowId={row => row.branch_scope}
            hasMore={false}
            onLoadMore={() => {}}
            density="compact"
            mobileLayout="compact"
            activeRowId={selectedRow?.branch_scope}
            onRowAction={id => {
              setDismissedAuto(false);
              setSelectedScope(id);
            }}
            empty={t("attendance.close.empty")}
            columns={[
              { id: "place", header: t("attendance.col.workplace"), card: "title", rowHeader: true, cell: row => placeName(row.branch_scope) },
              {
                id: "state",
                header: t("attendance.col.state"),
                card: "status",
                cell: row => <Chip tone={row.closed ? "ok" : "neutral"}>{t(row.closed ? "attendance.close.closed" : "attendance.close.open")}</Chip>,
              },
              {
                id: "issues",
                header: t("attendance.tab.issues"),
                card: "fact",
                cell: row => t(row.closed ? "attendance.close.frozenCount" : "attendance.count", { count: row.open_exceptions }),
              },
              {
                id: "leave",
                header: t("attendance.close.pendingLeave"),
                card: "fact",
                cell: row => t(row.closed ? "attendance.close.frozenCount" : "attendance.count", { count: row.pending_leave }),
              },
              {
                id: "closedAt",
                header: t("attendance.close.closedAt"),
                card: "omit",
                cell: row => (row.close ? <time dateTime={row.close.closed_at}>{fmtDateTime(row.close.closed_at)}</time> : "—"),
              },
              ...(hasLocks
                ? [
                    {
                      id: "lock",
                      header: t("attendance.close.periodLock"),
                      card: "omit",
                      cell: row =>
                        row.close?.period_lock_id ? (
                          <Link to="/people/period-locks" search={{ unlock: row.close.period_lock_id }}>
                            {t("attendanceRecords.month.requestUnlock")}
                          </Link>
                        ) : null,
                    } satisfies LongColumn<AttendanceMonthCloseItem>,
                  ]
                : []),
            ]}
          />
        </div>
      }
      onSelect={id => {
        setDismissedAuto(false);
        setSelectedScope(id);
      }}
      record={
        selectedRow
          ? {
              id: selectedRow.branch_scope,
              label: t("attendance.close.pane.title"),
              title: t("attendance.close.pane.title"),
              onClose: () => {
                setSelectedScope(undefined);
                setDismissedAuto(true);
              },
              children: (
                <div className={s.paneBody}>
                  <RecordIdentityBar
                    name={placeName(selectedRow.branch_scope)}
                    badges={<Chip tone={selectedRow.closed ? "ok" : "neutral"}>{t(selectedRow.closed ? "attendance.close.closed" : "attendance.close.open")}</Chip>}
                  />
                  <RecordPaneSection title={t("attendance.close.pane.title")}>
                    <KeyValue
                      density="dense"
                      label={t("attendance.close.pane.title")}
                      items={[
                        {
                          key: "issues",
                          label: t("attendance.tab.issues"),
                          value: t(selectedRow.closed ? "attendance.close.frozenCount" : "attendance.count", { count: selectedRow.open_exceptions }),
                        },
                        {
                          key: "leave",
                          label: t("attendance.close.pendingLeave"),
                          value: t(selectedRow.closed ? "attendance.close.frozenCount" : "attendance.count", { count: selectedRow.pending_leave }),
                        },
                        ...(selectedRow.close
                          ? [
                              { key: "attested", label: t("attendance.close.pane.attestedAt"), value: fmtDateTime(selectedRow.close.attested_at) },
                              { key: "closedAt", label: t("attendance.close.closedAt"), value: fmtDateTime(selectedRow.close.closed_at) },
                            ]
                          : []),
                      ]}
                    />
                  </RecordPaneSection>
                  {selectedRow.close && selectedRow.close.checks.length > 0 ? (
                    <RecordPaneSection title={t("attendance.close.pane.checks")}>
                      <KeyValue
                        density="dense"
                        label={t("attendance.close.pane.checks")}
                        items={selectedRow.close.checks.map((c, i) => ({
                          key: `${c.key}-${i}`,
                          label: c.note ?? c.key,
                          value: <Chip tone={c.ok ? "ok" : "warn"}>{t(c.ok ? "enum.checklistState.DONE" : "enum.checklistState.OPEN")}</Chip>,
                        }))}
                      />
                    </RecordPaneSection>
                  ) : null}
                  {selectedRow.close && selectedRow.close.amendments.length > 0 ? (
                    <RecordPaneSection title={t("attendance.close.pane.amendments")}>
                      <KeyValue
                        density="dense"
                        label={t("attendance.close.pane.amendments")}
                        items={selectedRow.close.amendments.map(a => ({
                          key: a.id,
                          label: a.reason,
                          value: <bdi className="num t-xs muted">{fmtDateTime(a.created_at)}</bdi>,
                        }))}
                      />
                    </RecordPaneSection>
                  ) : null}
                  <CloseConsoleActions
                    row={selectedRow}
                    activePreflight={activePreflight}
                    preflightError={runPreflight.error}
                    preflightPending={runPreflight.isPending}
                    onRunPreflight={() => runPreflight.mutate(selectedRow.branch_scope)}
                    onOpenConfirm={() => void openConfirm()}
                    onOpenAmend={() => setSheet("amend")}
                  />
                </div>
              ),
            }
          : null
      }
      overlays={
        sheet && selectedRow ? (
          <Suspense fallback={null}>
            {sheet === "confirm" ? (
              <CloseConfirmSheet month={month} branchScope={selectedRow.branch_scope} scopeLabel={placeName(selectedRow.branch_scope)} preflight={activePreflight} onClose={() => setSheet(null)} />
            ) : selectedRow.close ? (
              <CloseAmendSheet closeId={selectedRow.close.id} scopeLabel={placeName(selectedRow.branch_scope)} onClose={() => setSheet(null)} />
            ) : null}
          </Suspense>
        ) : undefined
      }
      statusSegments={
        board.data
          ? [
              { id: "closed", content: t("attendance.close.statusRatio", { closed: closedCount, total: displayItems.length }) },
              ...(selectedRow ? [{ id: "selected", tone: "strong" as const, content: placeName(selectedRow.branch_scope) }] : []),
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
