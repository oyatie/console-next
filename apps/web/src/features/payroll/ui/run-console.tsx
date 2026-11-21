// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { fmtMonth, fmtNumber } from "@console/i18n/format";
import { AlertTriangle, ChevronDown, ChevronUp, Download, FileText } from "lucide-react";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow } from "../../../ui/key-value/key-value";
import { PeriodStepper } from "../../../ui/period-stepper/period-stepper";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { RegisterTotals } from "../../../ui/patterns/register-totals";
import {
  RegisterFootBar,
  RegisterNowrap,
  RegisterToolbarSearch,
  RegisterToolbarSelect,
  RegisterTotalsStrip,
} from "../../../ui/patterns/register-totals-parts";
import { WorklistSearchField, WorklistSegmentBar } from "../../../ui/patterns/worklist-parts";
import { StepLine } from "../../../ui/step-line/step-line";
import { buildRunStageSteps, buildRunStatusSegments } from "../present";
import { RunRegisterTable } from "./run-console-columns";
import { RunPayslipPreview } from "./run-console-preview";
import { RunActionSheets, RunPrecheckBlockers } from "./run-console-sheets";
import { RUN_PAGE_LIMIT, useRunConsole } from "./use-run-console";

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
    entities,
    activePeriod,
    activeEntityId,
    entityLabel,
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
    submitOpen,
    setSubmitOpen,
    setOffset,
    setSelectedId,
    checkedIds,
    setCheckedIds,
    setPeriodOverride,
    setEntityOverride,
    hasBankIssues,
    runHeadcount,
    attentionCount,
    unreviewed,
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

  return (
    <RegisterTotals
      q={q}
      baseline={baseline}
      head={{
        title: t("payroll.title"),
        titleId: "payroll-run-title",
        filters: detailData ? (
          <>
            <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={activePeriod} onChange={setPeriodOverride} />
            {entities.length > 0 && (
              <RegisterToolbarSelect
                label={t("payroll.entity")}
                value={activeEntityId}
                onChange={setEntityOverride}
                options={entities.map(entity => ({ value: entity.id, label: entity.name ?? t("payroll.entityUnnamed") }))}
              />
            )}
            <WorklistSegmentBar
              label={t("payroll.run.filterLabel")}
              value={filter}
              onChange={handleFilterChange}
              items={[
                { id: "all", label: t("home.inbox.filter.all"), count: fmtNumber(runHeadcount) },
                {
                  id: "attention",
                  label: hasBankIssues ? t("payroll.run.missingBankFilter") : t("payroll.run.attentionFilter"),
                  count: fmtNumber(attentionCount),
                  tone: attentionCount > 0 ? "danger" : undefined,
                  icon: attentionCount > 0 ? <AlertTriangle size={12} aria-hidden="true" /> : undefined,
                },
              ]}
            />
            <RegisterToolbarSearch>
              <WorklistSearchField
                label={t("payroll.run.findPlaceholder")}
                value={findQuery}
                onChange={handleFindChange}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={e => {
                  setComposing(false);
                  handleFindChange(e.currentTarget.value);
                }}
              />
            </RegisterToolbarSearch>
          </>
        ) : undefined,
        tools: detailData ? (
          <>
            <Button size="sm" onClick={() => setExportOpen(true)}>
              <Download size={13} aria-hidden="true" />
              <RegisterNowrap>{t("payroll.run.export")}</RegisterNowrap>
            </Button>
            <Button size="sm" aria-pressed={showPreview} onClick={() => setShowPreview(prev => !prev)}>
              <FileText size={13} aria-hidden="true" />
              <RegisterNowrap>{t("payroll.run.previewToggle")}</RegisterNowrap>
            </Button>
          </>
        ) : undefined,
        primary: detailData ? { id: "submit", label: t("payroll.run.requestApproval"), onAction: () => setSubmitOpen(true) } : undefined,
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
        !scopeMismatch && detailData && (attentionCount > 0 || unreviewed) ? (
          <RunPrecheckBlockers
            attentionCount={attentionCount}
            hasBankIssues={hasBankIssues}
            readyCount={readyCount}
            unreviewed={unreviewed}
            filter={filter}
            onToggleFilter={() => handleFilterChange(filter === "attention" ? "all" : "attention")}
          />
        ) : null
      }
      register={
        scopeMismatch && run ? (
          <EmptyState
            title={t("payroll.run.emptyPeriod", { month: fmtMonth(activePeriod) })}
            reason={null}
            actions={<Button onClick={() => { setPeriodOverride(undefined); setEntityOverride(undefined); }}>{t("payroll.run.backToMonth", { month: fmtMonth(run.attribution_month) })}</Button>}
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
        <RunActionSheets
          detail={detailData}
          runHeadcount={runHeadcount}
          entityLabel={entityLabel}
          visibleLines={visibleLines}
          bankHoldCount={hasBankIssues ? attentionCount : 0}
          exportOpen={exportOpen}
          submitOpen={submitOpen}
          onCloseExport={() => setExportOpen(false)}
          onCloseSubmit={() => setSubmitOpen(false)}
        />
      }
    />
  );
}
