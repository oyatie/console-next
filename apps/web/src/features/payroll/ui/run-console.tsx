// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtMonth, fmtNumber } from "@console/i18n/format";
import { AlertTriangle, ChevronDown, ChevronUp, Download, FileText } from "lucide-react";
import { queryView, readGroup } from "../../../lib/react/query-view";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { operationAccess } from "../../../reference/authz/domain/operation-access";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow } from "../../../ui/key-value/key-value";
import { PeriodStepper } from "../../../ui/period-stepper/period-stepper";
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
import { payGroupsQuery, payrollDirectoryQuery, payrollRatesQuery, payrollRunQuery, type PayrollDirectoryEmployee } from "../api";
import { buildRunStageSteps, buildRunStatusSegments } from "./run-console-labels";
import {
  filterRegisterLines,
  hasBankBlocker,
  isLineAttention,
  type RegisterFilterMode,
} from "../domain/run-register";
import { RunRegisterTable } from "./run-console-columns";
import { RunPayslipPreview } from "./run-console-preview";
import { RunActionSheets, RunPrecheckBlockers } from "./run-console-sheets";

const PAGE_LIMIT = 50;
const formatWonOrDash = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? t("payroll.employee.won", { amount: fmtNumber(value) }) : "—";

/** Console (`P6` `RegisterTotals`) view for `/payroll/runs/$id`, falling back to `baseline()` in Classic mode. */
export function RunConsole({ id, baseline }: { id: string; baseline: () => ReactNode }) {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<RegisterFilterMode>("all");
  const [findQuery, setFindQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [showPreview, setShowPreview] = useState(true);
  const [periodOverride, setPeriodOverride] = useState<string>();
  const [entityOverride, setEntityOverride] = useState<string>();
  const [exportOpen, setExportOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);

  const detail = useQuery({
    ...payrollRunQuery(id, offset > 0 ? { limit: PAGE_LIMIT, offset } : undefined),
    placeholderData: offset > 0 ? keepPreviousData : undefined,
  });
  const groups = useQuery(payGroupsQuery);
  const q = readGroup([detail, groups]);
  const view = queryView(q);
  const detailData = detail.data;
  const run = detailData?.run;
  const entities = groups.data?.legal_entities ?? [];
  const activePeriod = periodOverride ?? run?.attribution_month ?? "2026-10";
  const activeEntityId = entityOverride ?? run?.legal_entity_id ?? "";
  const activeEntity = entities.find(entity => entity.id === activeEntityId);
  const entityLabel = activeEntity?.name ?? t("payroll.entityUnnamed");

  const lines = detailData?.lines ?? [];
  const access = useQuery(myAccessQuery);
  const canDirectory = Boolean(
    access.data && accessRefusal(access.data, operationAccess["GET /api/v1/employees"]) === null,
  );
  const directory = useQuery({
    ...payrollDirectoryQuery(run?.legal_entity_id ?? ""),
    enabled: canDirectory && lines.length > 0 && Boolean(run?.legal_entity_id),
  });
  const rates = useQuery({
    ...payrollRatesQuery(run?.legal_entity_id ?? ""),
    enabled: Boolean(run?.legal_entity_id && lines.length > 0),
  });
  const directoryById = new Map<string, PayrollDirectoryEmployee>();
  for (const emp of directory.data?.items ?? []) {
    directoryById.set(emp.id, emp);
  }

  const bankHoldOnPage = lines.filter(hasBankBlocker).length;
  const attentionOnPage = lines.filter(isLineAttention).length;
  const hasBankIssues = bankHoldOnPage > 0;
  const attentionCount = detailData ? Math.max(detailData.exceptions_open, attentionOnPage) : 0;
  const unreviewed = detailData?.calculation ? !detailData.calculation.payable : false;
  const scopeMismatch = Boolean(run && ((periodOverride && periodOverride !== run.attribution_month) || (entityOverride && entityOverride !== run.legal_entity_id)));

  const visibleLines = scopeMismatch ? [] : filterRegisterLines(lines, filter, findQuery, directoryById);
  const activeLine = visibleLines.find(line => line.id === selectedId) ?? visibleLines[0];
  const activeEmployee = activeLine?.employee_id ? directoryById.get(activeLine.employee_id) : undefined;
  const checkedOnPage = visibleLines.filter(line => checkedIds.has(line.id));
  const selectedStatusLine = checkedOnPage.length > 0 ? (checkedOnPage.find(line => line.id === activeLine?.id) ?? checkedOnPage[0]) : activeLine;
  const selectedStatusCount = checkedOnPage.length > 0 ? checkedOnPage.length : activeLine ? 1 : 0;
  const selectedEmployee = selectedStatusLine?.employee_id ? directoryById.get(selectedStatusLine.employee_id) : undefined;
  const selectedStatusName = selectedStatusLine
    ? selectedEmployee?.employee_number
      ? `${selectedStatusLine.employee_display_name} ${selectedEmployee.employee_number}`
      : selectedStatusLine.employee_display_name
    : "";

  const rangeFrom = detailData && lines.length > 0 ? detailData.lines_offset + 1 : 0;
  const rangeTo = detailData && lines.length > 0 ? detailData.lines_offset + lines.length : 0;
  const readyCount = detailData ? Math.max(0, detailData.lines_total - attentionCount) : 0;
  const dataReady = !q.isPending && !q.error && Boolean(detailData) && (view === "ready" || view === "stale" || view === "offline");

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
              onChange={setFilter}
              items={[
                { id: "all", label: t("home.inbox.filter.all"), count: fmtNumber(detailData.lines_total) },
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
              <WorklistSearchField label={t("payroll.run.findPlaceholder")} value={findQuery} onChange={setFindQuery} />
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
                  { key: "target", label: t("payroll.run.statTarget"), value: t("payroll.run.personCount", { count: detailData.lines_total }) },
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
            onToggleFilter={() => setFilter(prev => (prev === "attention" ? "all" : "attention"))}
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
          lines.length === 0 ? (
            <EmptyState title={t("payroll.run.emptyLines")} reason={null} />
          ) : (
            <EmptyState
              title={t("payroll.run.noMatch")}
              reason={null}
              actions={<Button onClick={() => { setFilter("all"); setFindQuery(""); }}>{t("payroll.run.resetFilter")}</Button>}
            />
          )
        ) : (
          <RunRegisterTable
            lines={visibleLines}
            linesTotal={detailData?.lines_total ?? visibleLines.length}
            directoryById={directoryById}
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
        !scopeMismatch && detailData && detailData.lines_total > 0 && lines.length > 0 ? (
          <RegisterFootBar
            range={t("payroll.run.range", { from: rangeFrom, to: rangeTo, total: detailData.lines_total })}
            actions={
              <>
                {detailData.lines_offset > 0 && (
                  <Button size="sm" onClick={() => setOffset(Math.max(0, detailData.lines_offset - PAGE_LIMIT))}>
                    <ChevronUp size={13} aria-hidden="true" />
                    <RegisterNowrap>{t("payroll.run.prevPage", { count: PAGE_LIMIT })}</RegisterNowrap>
                  </Button>
                )}
                {rangeTo < detailData.lines_total && (
                  <Button size="sm" onClick={() => setOffset(rangeTo)}>
                    <ChevronDown size={13} aria-hidden="true" />
                    <RegisterNowrap>{t("payroll.run.nextPage", { count: Math.min(PAGE_LIMIT, detailData.lines_total - rangeTo) })}</RegisterNowrap>
                  </Button>
                )}
              </>
            }
          />
        ) : null
      }
      preview={
        showPreview && !scopeMismatch && detailData && activeLine ? (
          <RunPayslipPreview detail={detailData} line={activeLine} employee={activeEmployee} rates={rates.data} />
        ) : null
      }
      statusSegments={
        dataReady && detailData
          ? buildRunStatusSegments({
              detailData,
              rangeFrom,
              rangeTo,
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
