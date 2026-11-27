// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, type ReactNode } from "react";
import { t, type MessageId } from "@console/i18n";
import { fmtMonth, fmtNumber } from "@console/i18n/format";
import { ChevronDown, ChevronUp } from "lucide-react";
import { chunk } from "../../../lib/chunk-guard";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow } from "../../../ui/key-value/key-value";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { RegisterTotals } from "../../../ui/patterns/register-totals";
import {
  RegisterFootBar,
  RegisterNowrap,
  RegisterTotalsStrip,
} from "../../../ui/patterns/register-totals-parts";
import { StepLine } from "../../../ui/step-line/step-line";
import { resolveRunStageAction } from "../domain/run-lifecycle";
import { buildRunStageSteps, buildRunStatusSegments } from "../present";
import { RunRegisterTable } from "./run-console-columns";
import { RunPayslipPreview } from "./run-console-preview";
import { RunActionSheets, RunPrecheckBlockers } from "./run-console-sheets";
import { RunConsoleFilters, RunConsoleTools } from "./run-console-toolbar";
import { RUN_PAGE_LIMIT, useRunConsole } from "./use-run-console";

const RunLifecycleSheet = lazy(() => chunk(import("./run-lifecycle-sheets")).then(m => ({ default: m.RunLifecycleSheet })));
const RunLifecyclePane = lazy(() => chunk(import("./run-lifecycle-pane")).then(m => ({ default: m.RunLifecyclePane })));

const formatWonOrDash = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? t("payroll.employee.won", { amount: fmtNumber(value) }) : "—";
/** Console (`P6` `RegisterTotals`) view for `/payroll/runs/$id`, falling back to `baseline()` in Classic mode. */
export function RunConsole({ id, baseline }: { id: string; baseline: () => ReactNode }) {
  return (
    <ExperienceSwitch baseline={baseline}>
      {() => <RunConsoleContent id={id} baseline={baseline} />}
    </ExperienceSwitch>
  );
}
function RunConsoleContent({ id, baseline }: { id: string; baseline: () => ReactNode }) {
  const {
    q,
    detailData,
    run,
    payGroupOptions,
    activePeriod,
    activeGroupKey,
    entityLabel,
    groupLabel,
    groupPeriodLabel,
    lines,
    ratesData,
    filter,
    findQuery,
    debouncedQ,
    setComposing,
    showPreview,
    setShowPreview,
    exportOpen,
    setExportOpen,
    lifecycleSheet,
    setLifecycleSheet,
    sideTab,
    setSideTab,
    setOffset,
    setSelectedId,
    checkedIds,
    setCheckedIds,
    setPeriodOverride,
    setGroupOverride,
    hasBankIssues,
    runHeadcount,
    attentionCount,
    unreviewed,
    attendanceOpenWarning,
    scopeMismatch,
    visibleLines,
    activeLine,
    checkedOnPage,
    selectedStatusLine,
    selectedStatusCount,
    selectedStatusName,
    rangeFrom,
    rangeTo,
    readyCount,
    dataReady,
    isPlaceholderData,
    handleFilterChange,
    handleFindChange,
    resetFilters,
  } = useRunConsole(id);

  const stageAction = run ? resolveRunStageAction(run.status) : null;
  const showStatutoryLink = Boolean(run && ["APPROVED", "DISBURSEMENT_SCHEDULED", "PAID", "ISSUED"].includes(run.status));
  return (
    <RegisterTotals
      q={q}
      baseline={baseline}
      head={{
        title: t("payroll.title"),
        titleId: "payroll-run-title",
        meta: groupPeriodLabel ? <bdi>{groupPeriodLabel}</bdi> : undefined,
        filters: detailData ? (
          <RunConsoleFilters
            activePeriod={activePeriod}
            setPeriodOverride={setPeriodOverride}
            payGroupOptions={payGroupOptions}
            activeGroupKey={activeGroupKey}
            setGroupOverride={setGroupOverride}
            filter={filter}
            handleFilterChange={handleFilterChange}
            runHeadcount={runHeadcount}
            hasBankIssues={hasBankIssues}
            attentionCount={attentionCount}
            findQuery={findQuery}
            handleFindChange={handleFindChange}
            setComposing={setComposing}
          />
        ) : undefined,
        tools: detailData ? (
          <RunConsoleTools
            sideTab={sideTab}
            onToggleSideTab={tab => setSideTab(prev => (prev === tab ? null : tab))}
            showStatutoryLink={showStatutoryLink}
            canRecalculate={run?.status === "CALCULATED"}
            onRecalculate={() => setLifecycleSheet("calculate")}
            onOpenExport={() => setExportOpen(true)}
            showPreview={showPreview}
            onTogglePreview={() => setShowPreview(prev => !prev)}
          />
        ) : undefined,
        primary: detailData && stageAction
          ? {
              id: "lifecycle",
              label: t(stageAction.labelKey as MessageId),
              onAction: () => {
                if (stageAction.kind === "sheet") setLifecycleSheet(stageAction.sheet);
                else setSideTab(stageAction.pane);
              },
            }
          : undefined,
      }}
      totals={
        detailData && run ? (
          <RegisterTotalsStrip
            stageLabel={t("payroll.stages.title")}
            stageRail={
              <StepLine label={t("payroll.stages.title")} steps={buildRunStageSteps(run)} />
            }
            stats={
              <StatRow
                label={t("payroll.title")}
                items={[
                  { key: "target", label: t("payroll.run.statTarget"), value: t("payroll.run.personCount", { count: runHeadcount }) },
                  { key: "gross", label: t("payroll.run.statGross"), value: formatWonOrDash(detailData.calculation?.total_gross_won) },
                  { key: "ded", label: t("payroll.run.statDeductions"), value: formatWonOrDash(detailData.calculation?.total_deductions_won) },
                  { key: "net", label: t("payroll.run.statNet"), value: formatWonOrDash(detailData.calculation?.total_net_won) },
                ]}
              />
            }
          />
        ) : null
      }
      blockers={
        !scopeMismatch && detailData && (attendanceOpenWarning || attentionCount > 0 || detailData.exceptions_open > 0 || unreviewed) ? (
          <RunPrecheckBlockers
            attendanceOpenWarning={attendanceOpenWarning}
            runStatus={run?.status}
            attentionCount={attentionCount}
            hasBankIssues={hasBankIssues}
            readyCount={readyCount}
            exceptionsOpen={detailData.exceptions_open}
            unreviewed={unreviewed}
            filter={filter}
            onToggleFilter={() => handleFilterChange(filter === "attention" ? "all" : "attention")}
            onInspectExceptions={() => setSideTab("exceptions")}
          />
        ) : null
      }
      register={
        scopeMismatch && run ? (
          <EmptyState
            title={t("payroll.run.emptyPeriod", { month: fmtMonth(activePeriod) })}
            reason={null}
            actions={<Button onClick={() => { setPeriodOverride(undefined); setGroupOverride(undefined); }}>{t("payroll.run.backToMonth", { month: fmtMonth(run.attribution_month) })}</Button>}
          />
        ) : visibleLines.length === 0 ? (
          !isPlaceholderData && lines.length === 0 && filter === "all" && !findQuery.trim() && !debouncedQ ? (
            <EmptyState title={t("payroll.run.emptyLines")} reason={null} />
          ) : (
            <EmptyState
              title={t("payroll.run.noMatch")}
              reason={null}
              actions={<Button onClick={resetFilters}>{t("payroll.run.resetFilter")}</Button>}
            />
          )
        ) : (
          <RunRegisterTable
            lines={visibleLines}
            linesTotal={detailData?.lines_total ?? visibleLines.length}
            selectedId={activeLine?.id}
            onSelect={setSelectedId}
            checkedIds={checkedIds}
            onToggleRow={(rowId, checked) =>
              setCheckedIds(prev => {
                const next = new Set(prev);
                if (checked) next.add(rowId);
                else next.delete(rowId);
                return next;
              })
            }
            onToggleAll={checked => setCheckedIds(checked ? new Set(visibleLines.map(line => line.id)) : new Set())}
          />
        )
      }
      foot={
        !scopeMismatch && detailData && detailData.lines_total > 0 && visibleLines.length > 0 ? (
          <RegisterFootBar
            range={t("payroll.run.range", { from: rangeFrom, to: rangeTo, total: detailData.lines_total })}
            actions={
              <>
                {detailData.lines_offset > 0 && (
                  <Button size="sm" onClick={() => setOffset(Math.max(0, detailData.lines_offset - RUN_PAGE_LIMIT))}>
                    <ChevronUp size={13} aria-hidden="true" />
                    <RegisterNowrap>{t("payroll.run.prevPage", { count: RUN_PAGE_LIMIT })}</RegisterNowrap>
                  </Button>
                )}
                {rangeTo < detailData.lines_total && (
                  <Button size="sm" onClick={() => setOffset(rangeTo)}>
                    <ChevronDown size={13} aria-hidden="true" />
                    <RegisterNowrap>{t("payroll.run.nextPage", { count: Math.min(RUN_PAGE_LIMIT, detailData.lines_total - rangeTo) })}</RegisterNowrap>
                  </Button>
                )}
              </>
            }
          />
        ) : null
      }
      preview={
        showPreview && !scopeMismatch && detailData && activeLine ? (
          <RunPayslipPreview detail={detailData} line={activeLine} rates={ratesData} />
        ) : null
      }
      record={
        sideTab && detailData
          ? {
              id: `run-${sideTab}`,
              label: t(`payrollRun.tool.${sideTab}`),
              title: t(`payrollRun.tool.${sideTab}`),
              onClose: () => setSideTab(null),
              children: (
                <Suspense fallback={null}>
                  <RunLifecyclePane tab={sideTab} detail={detailData} onSelectLine={setSelectedId} />
                </Suspense>
              ),
            }
          : null
      }
      statusSegments={
        dataReady && detailData
          ? buildRunStatusSegments({
              runHeadcount,
              rangeFrom,
              rangeTo,
              checkedLines: checkedOnPage,
              selectedStatusLine,
              selectedStatusCount,
              selectedStatusName,
              attentionCount,
              hasBankIssues,
            })
          : null
      }
      overlays={
        <>
          <RunActionSheets
            detail={detailData}
            entityLabel={entityLabel}
            groupLabel={groupLabel}
            visibleLines={visibleLines}
            exportOpen={exportOpen}
            onCloseExport={() => setExportOpen(false)}
          />
          {lifecycleSheet && detailData && (
            <Suspense fallback={null}>
              <RunLifecycleSheet
                kind={lifecycleSheet}
                detail={detailData}
                runHeadcount={runHeadcount}
                bankHoldCount={hasBankIssues ? attentionCount : 0}
                onClose={() => setLifecycleSheet(null)}
              />
            </Suspense>
          )}
        </>
      }
    />
  );
}
