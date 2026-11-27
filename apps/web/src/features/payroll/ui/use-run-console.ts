// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import { SEARCH_DEBOUNCE_MS } from "../../../lib/freshness";
import { queryView, readGroup } from "../../../lib/react/query-view";
import { payGroupsQuery, payrollRatesQuery, payrollRunQuery } from "../api";
import {
  filterRegisterLines,
  isLineAttention,
  type RegisterFilterMode,
} from "../domain/run-register";

import type { RunLifecycleSheetKind } from "../domain/run-lifecycle";
import type { RunSideTab } from "./run-lifecycle-pane";

export const RUN_PAGE_LIMIT = 50;

export function useRunConsole(id: string) {
  const [prevId, setPrevId] = useState(id);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<RegisterFilterMode>("all");
  const [findQuery, setFindQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [composing, setComposing] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [showPreview, setShowPreview] = useState(true);
  const [periodOverride, setPeriodOverride] = useState<string>();
  const [groupOverride, setGroupOverride] = useState<string>();
  const [exportOpen, setExportOpen] = useState(false);
  const [lifecycleSheet, setLifecycleSheet] = useState<RunLifecycleSheetKind | null>(null);
  const [sideTab, setSideTab] = useState<RunSideTab | null>(null);
  const [latchedHeadcount, setLatchedHeadcount] = useState<{ runId: string; total: number } | null>(null);
  const [bankIssuesKnown, setBankIssuesKnown] = useState(false);

  if (prevId !== id) {
    setPrevId(id);
    setOffset(0);
    setFilter("all");
    setFindQuery("");
    setDebouncedQ("");
    setSelectedId(undefined);
    setCheckedIds(new Set());
    setPeriodOverride(undefined);
    setGroupOverride(undefined);
    setLatchedHeadcount(null);
    setBankIssuesKnown(false);
  }

  useEffect(() => {
    if (composing) return;
    const trimmed = findQuery.trim();
    if (!trimmed || trimmed === debouncedQ) return;
    const timer = setTimeout(() => {
      setDebouncedQ(trimmed);
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [findQuery, composing, debouncedQ]);

  const missingBankOnly = filter === "attention" && bankIssuesKnown;
  const serverQ = debouncedQ || undefined;
  const queryParams =
    offset > 0 || missingBankOnly || serverQ
      ? {
          limit: RUN_PAGE_LIMIT,
          ...(offset > 0 ? { offset } : {}),
          ...(missingBankOnly ? { missing_bank_only: true } : {}),
          ...(serverQ ? { q: serverQ } : {}),
        }
      : undefined;

  const detail = useQuery({
    ...payrollRunQuery(id, queryParams),
    placeholderData: prev => (prev?.run.id === id ? prev : undefined),
  });
  const groups = useQuery(payGroupsQuery);
  const q = readGroup([detail, groups]);
  const view = queryView(q);
  const detailData = detail.data;
  const run = detailData?.run;
  const entities = groups.data?.legal_entities ?? [];
  const rawGroups = groups.data?.items ?? [];
  const nameCounts = new Map<string, number>();
  for (const item of rawGroups) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
  const payGroupOptions = rawGroups.map(item => {
    const entity = entities.find(e => e.id === item.legal_entity_id);
    const duplicate = (nameCounts.get(item.name) ?? 0) > 1;
    const label = duplicate && entity?.name ? `${entity.name} · ${item.name}` : item.name;
    return {
      value: `${item.legal_entity_id}:${item.id}`,
      entityId: item.legal_entity_id,
      groupId: item.id,
      name: item.name,
      label,
    };
  });
  const activePeriod = periodOverride ?? run?.attribution_month ?? "2026-10";
  const defaultGroupKey = run ? `${run.legal_entity_id}:${run.pay_group_id}` : (payGroupOptions[0]?.value ?? "");
  const activeGroupKey = groupOverride ?? defaultGroupKey;
  const selectedGroup = payGroupOptions.find(option => option.value === activeGroupKey);
  const activeEntityId = selectedGroup?.entityId ?? run?.legal_entity_id ?? "";
  const activeEntity = entities.find(entity => entity.id === activeEntityId);
  const entityLabel = activeEntity?.name ?? t("payroll.entityUnnamed");
  // A group id is unique only within its legal entity: never name another entity's group.
  const groupLabel = run && groups.data
    ? selectedGroup?.label ?? `${t("payroll.group")} · ${t("payroll.rule.unknown")}`
    : undefined;
  const groupPeriodLabel = groupLabel
    ? `${groupLabel} · ${fmtMonth(activePeriod)}`
    : detailData
      ? fmtMonth(activePeriod)
      : undefined;

  const lines = detailData?.lines ?? [];
  const rates = useQuery({
    ...payrollRatesQuery(run?.legal_entity_id ?? ""),
    enabled: Boolean(run?.legal_entity_id && lines.length > 0),
  });

  const missingBankCount = detailData?.missing_bank_account_count ?? 0;
  const serverMissingBank = missingBankCount > 0;
  const attentionOnPage = lines.filter(isLineAttention).length;
  if (detailData && !detail.isPlaceholderData && serverMissingBank !== bankIssuesKnown) {
    setBankIssuesKnown(serverMissingBank);
  }
  const hasBankIssues = detailData && !detail.isPlaceholderData ? serverMissingBank : bankIssuesKnown;
  const isFilteredQuery = missingBankOnly || Boolean(serverQ);
  if (!isFilteredQuery && detailData && !detail.isPlaceholderData) {
    if (latchedHeadcount?.runId !== detailData.run.id || latchedHeadcount.total !== detailData.lines_total) {
      setLatchedHeadcount({ runId: detailData.run.id, total: detailData.lines_total });
    }
  }
  const runHeadcount = detailData?.calculation
    ? detailData.calculation.calculated_lines + detailData.calculation.blocked_lines
    : latchedHeadcount && detailData && latchedHeadcount.runId === detailData.run.id
      ? latchedHeadcount.total
      : (detailData?.lines_total ?? 0);

  const attentionCount = hasBankIssues
    ? missingBankCount
    : detailData
      ? Math.max(detailData.exceptions_open, attentionOnPage)
      : 0;
  const unreviewed = detailData?.calculation ? !detailData.calculation.payable : false;
  const attendanceOpenWarning = Boolean(run && (run.status === "STAGED" || run.status === "BLOCKED_LEGAL_GATE"));
  const scopeMismatch = Boolean(
    run &&
      ((periodOverride && periodOverride !== run.attribution_month) ||
        (groupOverride && groupOverride !== defaultGroupKey)),
  );

  const awaitingServerFilter = composing || findQuery.trim() !== debouncedQ || detail.isPlaceholderData;
  const visibleLines = scopeMismatch
    ? []
    : awaitingServerFilter
      ? missingBankOnly
        ? lines
        : filterRegisterLines(lines, filter, "")
      : filterRegisterLines(lines, filter, findQuery);
  const activeLine = visibleLines.find(line => line.id === selectedId) ?? visibleLines[0];
  const checkedOnPage = visibleLines.filter(line => checkedIds.has(line.id));
  const selectedStatusLine =
    checkedOnPage.length > 0 ? (checkedOnPage.find(line => line.id === activeLine?.id) ?? checkedOnPage[0]) : activeLine;
  const selectedStatusCount = checkedOnPage.length > 0 ? checkedOnPage.length : activeLine ? 1 : 0;
  const selectedStatusName = selectedStatusLine
    ? selectedStatusLine.employee_number
      ? `${selectedStatusLine.employee_display_name} ${selectedStatusLine.employee_number}`
      : selectedStatusLine.employee_display_name
    : "";

  const rangeFrom = detailData && lines.length > 0 ? detailData.lines_offset + 1 : 0;
  const rangeTo = detailData && lines.length > 0 ? detailData.lines_offset + lines.length : 0;
  const readyCount = Math.max(0, runHeadcount - attentionCount);
  const dataReady =
    !q.isPending && !q.error && Boolean(detailData) && (view === "ready" || view === "stale" || view === "offline");

  const handleFilterChange = (next: RegisterFilterMode) => {
    setFilter(next);
    setOffset(0);
  };
  const handleFindChange = (next: string) => {
    setFindQuery(next);
    if (!next.trim()) {
      setDebouncedQ("");
      setOffset(0);
    }
  };
  const resetFilters = () => {
    setFilter("all");
    setFindQuery("");
    setDebouncedQ("");
    setOffset(0);
  };

  return {
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
    ratesData: rates.data,
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
    isPlaceholderData: detail.isPlaceholderData,
    handleFilterChange,
    handleFindChange,
    resetFilters,
  };
}
