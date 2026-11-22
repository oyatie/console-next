// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { readGroup } from "../../../lib/react/query-view";
import { QueryState } from "../../../lib/react/query-state";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { operationAccess } from "../../../reference/authz/domain/operation-access";
import { Button } from "../../../ui/button/button";
import { Segmented } from "../../../ui/button/segmented";
import { EmptyState } from "../../../ui/empty-state";
import { SelectInput } from "../../../ui/field/select-input";
import { StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { PageHead } from "../../../ui/page-head/page-head";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { WorklistSearchField } from "../../../ui/patterns/worklist-parts";
import {
  isRefusalError,
  teamAccessQuery,
  teamEmployeesPages,
  teamFacetsQuery,
  teamLeaveQueueQuery,
  teamMeQuery,
} from "../api";
import {
  buildTeamQueryParams,
  computeTeamStats,
  deriveTeamScopes,
  filterTeamEmployees,
} from "../domain/team-scope";
import { buildTeamColumns } from "./team-columns";
import { TeamRecordPane } from "./team-record-pane";
import s from "./team.module.css";

export type TeamView = "all" | "direct" | "concurrent";
export type TeamStatusFilter = "all" | "ACTIVE" | "ON_LEAVE" | "SOON" | "MISSING";
export type TeamSearch = {
  view?: TeamView;
  scopeId?: string;
  status?: TeamStatusFilter;
  q?: string;
  sort?: string;
  sel?: string;
};

const route = getRouteApi("/app/team");

export function TeamPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const today = todayKst();

  const access = useQuery(teamAccessQuery);
  const me = useQuery(teamMeQuery);
  const scopes = useMemo(() => deriveTeamScopes(access.data, me.data), [access.data, me.data]);

  const activeView: TeamView =
    search.view === "concurrent" && scopes.hasConcurrent
      ? "concurrent"
      : search.view === "direct"
        ? "direct"
        : "all";
  const statusFilter: TeamStatusFilter = search.status ?? "all";
  const selectedScope =
    scopes.concurrentScopes.find(scope => scope.id === search.scopeId) ?? scopes.concurrentScopes[0];

  const queryParams = useMemo(
    () =>
      buildTeamQueryParams({
        view: activeView,
        selectedScope,
        statusFilter,
        search: search.q,
        sort: search.sort,
      }),
    [activeView, selectedScope, statusFilter, search.q, search.sort],
  );

  const employees = useInfiniteQuery(teamEmployeesPages(queryParams));
  const facets = useQuery({
    ...teamFacetsQuery({
      org_unit_id: queryParams.org_unit_id,
      workplace_id: queryParams.workplace_id,
      legal_entity_id: queryParams.legal_entity_id,
    }),
    retry: false,
  });

  const canReadLeave = Boolean(
    access.data && accessRefusal(access.data, operationAccess["GET /api/v1/employees"]) === null,
  );
  const leaveQueue = useQuery({ ...teamLeaveQueueQuery, enabled: canReadLeave, retry: false });
  const pendingLeaves = useMemo(
    () => (leaveQueue.isError && isRefusalError(leaveQueue.error) ? [] : (leaveQueue.data?.items ?? [])),
    [leaveQueue.isError, leaveQueue.error, leaveQueue.data],
  );

  const rawRows = useMemo(() => employees.data?.pages.flatMap(p => p.items) ?? [], [employees.data]);
  const rows = useMemo(
    () =>
      filterTeamEmployees(rawRows, {
        view: activeView,
        directUnitName: scopes.directUnitName,
        statusFilter,
        today,
      }),
    [rawRows, activeView, scopes.directUnitName, statusFilter, today],
  );

  const selectedMember = rows.find(row => row.id === search.sel);
  const go = (patch: Partial<TeamSearch>) => void navigate({ search: prev => ({ ...prev, ...patch }) });

  const isClientFiltered = activeView === "direct" || statusFilter !== "all" || Boolean(search.q?.trim());
  const visibleIds = useMemo(() => new Set(rows.map(r => r.id)), [rows]);
  const visibleLeaves = useMemo(
    () => (isClientFiltered ? pendingLeaves.filter(req => visibleIds.has(req.subject_employee_id)) : pendingLeaves),
    [isClientFiltered, pendingLeaves, visibleIds],
  );
  const { totalCount, activeCount, onLeaveCount, contractEndingCount, attentionCount } = computeTeamStats({
    rows,
    visibleLeaves,
    facets: facets.data,
    pagesTotal: employees.data?.pages[0]?.total,
    isClientFiltered,
    today,
  });

  const columns = buildTeamColumns(today, pendingLeaves);

  const primaryRead = readGroup([employees]);
  const viewItems = [
    { id: "all" as const, label: t("team.view.all") },
    { id: "direct" as const, label: t("team.view.direct") },
    ...(scopes.hasConcurrent ? [{ id: "concurrent" as const, label: t("team.view.concurrent") }] : []),
  ];
  const filterItems = [
    { id: "all" as const, label: t("team.filter.all") },
    { id: "ACTIVE" as const, label: t("team.filter.active") },
    { id: "ON_LEAVE" as const, label: t("team.filter.onLeave") },
    { id: "SOON" as const, label: t("team.filter.soon") },
    { id: "MISSING" as const, label: t("team.filter.missing") },
  ];

  const viewsBar = (
    <div className={s.controls}>
      <Segmented label={t("team.views")} size="sm" value={activeView} onChange={view => go({ view, sel: undefined })} items={viewItems} />
      {activeView === "concurrent" && scopes.concurrentScopes.length > 1 ? (
        <SelectInput
          aria-label={t("team.concurrent.pick")}
          className={s.scopeSelect}
          value={selectedScope?.id ?? ""}
          onChange={e => go({ scopeId: e.target.value, sel: undefined })}
        >
          {scopes.concurrentScopes.map(scope => (
            <option key={scope.id} value={scope.id}>
              {scope.name}
            </option>
          ))}
        </SelectInput>
      ) : null}
    </div>
  );

  const filtersBar = (
    <Segmented
      label={t("team.filter.label")}
      size="sm"
      value={statusFilter}
      onChange={status => go({ status, sel: undefined })}
      items={filterItems}
    />
  );

  const findBar = (
    <div data-list-find="">
      <WorklistSearchField label={t("team.find.placeholder")} value={search.q ?? ""} onChange={q => go({ q: q || undefined, sel: undefined })} />
    </div>
  );

  const consoleFilters = (
    <div className={s.filterFindRow}>
      <div className={s.desktopOnly}>{filtersBar}</div>
      <SelectInput
        aria-label={t("team.filter.label")}
        className={s.phoneFilterSelect}
        value={statusFilter}
        onChange={e => go({ status: e.target.value as TeamStatusFilter, sel: undefined })}
      >
        {filterItems.map(item => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </SelectInput>
      {findBar}
    </div>
  );

  const tableNode = (
    <div className={s.tableWrap}>
      <LongTable
        label={t("team.table.label")}
        rows={rows}
        rowId={r => r.id}
        total={totalCount}
        hasMore={Boolean(employees.hasNextPage)}
        loadingMore={employees.isFetchingNextPage}
        onLoadMore={() => void (employees.hasNextPage && !employees.isFetchingNextPage && employees.fetchNextPage())}
        density="compact"
        mobileLayout="compact"
        activeRowId={selectedMember?.id}
        onRowAction={id => go({ sel: id })}
        empty={
          <EmptyState
            title={t("team.empty.title")}
            reason={t("team.empty.reason")}
            actions={
              statusFilter !== "all" || search.q ? (
                <Button onClick={() => go({ status: "all", q: undefined, view: "all" })}>{t("team.empty.reset")}</Button>
              ) : undefined
            }
          />
        }
        columns={columns}
      />
    </div>
  );

  const baseline = () => (
    <main className="page" data-floorplan="P-01">
      <PageHead title={t("team.title")} filters={viewsBar} />
      <PageReadGate q={primaryRead}>
        <QueryState q={primaryRead} layout="list">
          {() => (
            <div className={s.baselineWrap}>
              {filtersBar}
              {findBar}
              {tableNode}
            </div>
          )}
        </QueryState>
      </PageReadGate>
    </main>
  );

  const noteText =
    visibleLeaves.length > 0 && contractEndingCount > 0
      ? t("team.notes.attention", { leaveCount: visibleLeaves.length, contractCount: contractEndingCount })
      : visibleLeaves.length > 0
        ? t("team.notes.leaveOnly", { leaveCount: visibleLeaves.length })
        : contractEndingCount > 0
          ? t("team.notes.contractOnly", { contractCount: contractEndingCount })
          : null;

  return (
    <ListRecord
      q={primaryRead}
      head={{ title: t("team.title"), titleId: "team-title", actions: viewsBar }}
      filters={consoleFilters}
      stats={
        <StatRow
          label={t("team.stats.label")}
          items={[
            { key: "total", label: t("team.stats.total"), value: totalCount },
            { key: "active", label: t("team.stats.active"), value: activeCount, onPress: () => go({ status: "ACTIVE" }), active: statusFilter === "ACTIVE" },
            { key: "leave", label: t("team.stats.onLeave"), value: onLeaveCount, onPress: () => go({ status: "ON_LEAVE" }), active: statusFilter === "ON_LEAVE" },
            {
              key: "attention",
              label: t("team.stats.attention"),
              value: attentionCount,
              tone: attentionCount > 0 ? "warn" : undefined,
              onPress: () => go({ status: "SOON" }),
              active: statusFilter === "SOON",
            },
          ]}
        />
      }
      notes={noteText ? <RecordBannerBand tone="warn"><bdi>{noteText}</bdi></RecordBannerBand> : undefined}
      list={tableNode}
      onSelect={id => go({ sel: id })}
      record={
        selectedMember
          ? {
              id: selectedMember.id,
              label: t("team.pane.title"),
              title: t("team.pane.title"),
              openInTab: { href: `/people/${selectedMember.id}`, label: selectedMember.name },
              onClose: () => go({ sel: undefined }),
              children: <TeamRecordPane member={selectedMember} leaveRequests={pendingLeaves} />,
            }
          : null
      }
      statusSegments={
        employees.data
          ? [
              { id: "count", content: t("team.status.scopeCount", { count: totalCount }) },
              ...(selectedMember
                ? [
                    {
                      id: "selected",
                      tone: "strong" as const,
                      content: t("team.status.selected", {
                        name: selectedMember.name,
                        code: selectedMember.employee_number ?? "",
                      }),
                    },
                  ]
                : []),
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
