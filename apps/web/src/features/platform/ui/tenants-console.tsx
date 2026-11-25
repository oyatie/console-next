// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { useOnline } from "../../../lib/react/use-online";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow, type StatRowItem } from "../../../ui/key-value/key-value";
import { rowById } from "../../../ui/long-table/row-keys";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ListSummaryFooter } from "../../../ui/patterns/list-record-parts";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { WorklistSearchField } from "../../../ui/patterns/worklist-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { SortControl } from "../../../ui/sort-control/sort-control";
import { Table } from "../../../ui/table";
import { groupsQuery, opsQuery, tenantsQuery, type Health, type Org, type OrgStatus, type Recorded } from "../api";
import {
  filterTenants,
  sortTenants,
  tenantKpiCounts,
  type TenantLifecycle,
  type TenantSortField,
  type View,
} from "../domain/tenants";
import { TenantConsoleOverlays, type IssuedTenantCode } from "./tenant-console-overlays";
import { TenantConsolePanel } from "./tenant-console-panel";
import { buildTenantColumns, statusesForView, viewForStatuses } from "./tenants-console-data";
import { TenantsConsoleRail } from "./tenants-console-rail";
import { useDelayedSearch } from "./use-delayed-search";
import { useDesktopAutoSelect } from "./use-desktop-auto-select";
import s from "./platform-console.module.css";

const route = getRouteApi("/app/platform");
type TenantsSearch = { sel?: string; q?: string; view?: Exclude<View, "active"> };
type TenantsConsoleProps = { tabs: ReactNode; onOpenSupport: (orgId: string) => void };

/** Opening an account checks the new name against the list, so it waits for the list and says why when the list cannot load. */
export function TenantsConsole(props: TenantsConsoleProps) {
  // Always mounted, so the page keeps its state when creation turns unavailable or back.
  return (
    <DisabledReason reason={t("tenants.create.unavailable")} control={(p) => <Button variant="primary" {...p}>{t("tenants.create")}</Button>}>
      {({ control, reason }) => <TenantsConsolePage {...props} unavailableCreate={control} unavailableReason={reason} />}
    </DisabledReason>
  );
}

function TenantsConsolePage({
  tabs,
  onOpenSupport,
  unavailableCreate,
  unavailableReason,
}: TenantsConsoleProps & { unavailableCreate: ReactNode; unavailableReason: ReactNode }) {
  const { sel, q: q0 = "", view } = route.useSearch();
  const navigate = route.useNavigate();
  const set = (next: TenantsSearch) => navigate({ search: (p) => ({ ...p, ...next }), replace: true });
  const list = useQuery(tenantsQuery);
  const online = useOnline();
  const unavailable = list.data === undefined && ["failed", "offline"].includes(queryView(online ? list : { ...list, fetchStatus: "paused" }));
  const ops = useQuery(opsQuery);
  const all = useMemo(() => (list.data ?? []).filter((o) => o.slug !== "platform"), [list.data]);
  const groups = useQuery({ ...groupsQuery, enabled: all.length > 0, retry: false });

  const pushedView = useRef(view);
  const [statuses, setStatuses] = useState<Set<OrgStatus>>(() => statusesForView(view));
  useEffect(() => {
    if (view === pushedView.current) return;
    pushedView.current = view;
    setStatuses(statusesForView(view));
  }, [view]);
  const [lifecycles, setLifecycles] = useState<Set<TenantLifecycle>>(() => new Set());
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [sort, setSort] = useState<{ field: TenantSortField; direction: "asc" | "desc" }>({
    field: "created_at",
    direction: "desc",
  });
  const [full, setFull] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedTenantCode | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const health = useMemo(() => new Map<string, Health>((ops.data?.tenants ?? []).map((h) => [h.id, h])), [ops.data]);
  const counts = useMemo(() => tenantKpiCounts(all), [all]);
  const { q, setQ } = useDelayedSearch(
    q0,
    (next) => void navigate({ search: (p) => ({ ...p, q: next }), replace: true }),
    (val) => filterTenants(all, { q: val, statuses: new Set(), lifecycles: new Set(), groupFilter: null, attentionOnly: false }).length,
  );
  const filtered = useMemo(
    () => filterTenants(all, { q, statuses, lifecycles, groupFilter, attentionOnly }),
    [all, q, statuses, lifecycles, groupFilter, attentionOnly],
  );
  const rows = useMemo(() => sortTenants(filtered, sort.field, sort.direction), [filtered, sort]);
  const columns = useMemo(() => buildTenantColumns(health), [health]);
  const { effectiveId: effectiveSel, select, dismiss } = useDesktopAutoSelect({
    rows,
    getId: (o) => o.id,
    explicitId: sel,
    onSelectExplicit: (id) => void set({ sel: id }),
    onClearExplicit: () => void set({ sel: undefined }),
  });
  const selected = all.find((o) => o.id === effectiveSel);

  const record = (r: Recorded) => {
    setRecorded(r);
    focusSoon("tenants-receipt");
  };

  const updateStatuses = (next: Set<OrgStatus>) => {
    setStatuses(next);
    const nextView = viewForStatuses(next);
    if (nextView !== view) {
      pushedView.current = nextView;
      void set({ view: nextView });
    }
  };

  const toggleStatus = (status: OrgStatus) => {
    const next = new Set(statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    updateStatuses(next);
  };

  const toggleLifecycle = (lc: TenantLifecycle) =>
    setLifecycles((prev) => {
      const next = new Set(prev);
      if (next.has(lc)) next.delete(lc);
      else next.add(lc);
      return next;
    });

  const resetFilters = () => {
    setQ("");
    setStatuses(new Set());
    setLifecycles(new Set());
    setGroupFilter(null);
    setAttentionOnly(false);
    pushedView.current = undefined;
    if (view !== undefined || q0) void set({ q: undefined, view: undefined });
  };

  const activeFilterCount = statuses.size + lifecycles.size + (groupFilter ? 1 : 0) + (attentionOnly ? 1 : 0);
  const empty = list.data !== undefined && all.length === 0;
  const notices = [...(ops.data?.notices ?? []), ...(ops.data?.registration_check_notices ?? [])];

  const statItems: StatRowItem[] = [
    { key: "all", label: t("tenants.view.all"), value: fmtNumber(counts.all), active: !attentionOnly && statuses.size === 0, onPress: () => { setAttentionOnly(false); updateStatuses(new Set()); } },
    { key: "active", label: t("tenants.view.active"), value: fmtNumber(counts.active), tone: "ok", active: !attentionOnly && statuses.size === 1 && statuses.has("ACTIVE"), onPress: () => { setAttentionOnly(false); updateStatuses(new Set(["ACTIVE"])); } },
    { key: "suspended", label: t("tenants.view.suspended"), value: fmtNumber(counts.suspended), tone: "warn", active: !attentionOnly && statuses.size === 1 && statuses.has("SUSPENDED"), onPress: () => { setAttentionOnly(false); updateStatuses(new Set(["SUSPENDED"])); } },
    { key: "archived", label: t("tenants.view.archived"), value: fmtNumber(counts.archived), tone: "muted", active: !attentionOnly && statuses.size === 1 && statuses.has("ARCHIVED"), onPress: () => { setAttentionOnly(false); updateStatuses(new Set(["ARCHIVED"])); } },
    { key: "attention", label: t("tenants.stat.attention"), value: fmtNumber(counts.attention), tone: counts.attention > 0 ? "danger" : "muted", active: attentionOnly, onPress: () => { updateStatuses(new Set()); setAttentionOnly((prev) => !prev); } },
  ];

  const sortControl = (
    <SortControl
      fields={[
        { id: "created_at", label: t("tenants.col.created") },
        { id: "name", label: t("tenants.col.name") },
        { id: "status", label: t("tenants.col.status") },
      ]}
      field={sort.field}
      direction={sort.direction}
      onChange={setSort}
    />
  );

  return (
    <ListRecord
      tabs={tabs}
      q={list}
      head={{
        title: t("tenants.title"),
        titleId: "tenants-title",
        actions: (
          <div className={s.headActions}>
            <Button size="sm" variant="secondary" onClick={() => setLookupOpen(true)}>
              <Search size={13} aria-hidden />
              {t("tenants.supportLookup.title")}
            </Button>
          </div>
        ),
        primary: empty ? undefined : unavailable ? <>{unavailableCreate}</> : (
          <Button variant="primary" disabled={!list.data} onClick={() => setOnboarding(true)}>
            {t("tenants.create")}
          </Button>
        ),
      }}
      failedActions={unavailable ? unavailableReason : undefined}
      find={!empty ? <div className={s.findWrap} data-list-find=""><WorklistSearchField label={t("tenants.search")} value={q} onChange={setQ} /></div> : undefined}
      tools={!empty ? <div className={s.desktopTools}>{sortControl}</div> : undefined}
      stats={!empty ? <StatRow label={t("tenants.stat.label")} items={statItems} /> : undefined}
      rail={!empty ? (
        <TenantsConsoleRail
          all={all}
          groups={groups.data ?? []}
          statuses={statuses}
          lifecycles={lifecycles}
          groupFilter={groupFilter}
          activeFilterCount={activeFilterCount}
          hasQuery={Boolean(q)}
          phoneTools={sortControl}
          onToggleStatus={toggleStatus}
          onToggleLifecycle={toggleLifecycle}
          onSelectGroup={setGroupFilter}
          onReset={resetFilters}
        />
      ) : undefined}
      notes={
        <>
          {ops.isError ? <QueryState q={ops} own={() => t("tenants.opsFailed")}>{() => null}</QueryState> : null}
          {notices.map((notice) => (
            <RecordBannerBand key={notice.env} tone={notice.state === "EXPIRING" ? "warn" : "neutral"}>
              <bdi>{t(`nts.ops.${notice.state}`, { env: notice.env })}{notice.expires_on ? ` · ${fmtDate(notice.expires_on)}` : ""}</bdi>
            </RecordBannerBand>
          ))}
          {recorded ? <div id="tenants-receipt" tabIndex={-1}><Receipt state="recorded" message={recorded.message} meta={recorded.meta} /></div> : null}
        </>
      }
      list={
        <div ref={tableRef} id="tenants-list" className={s.tableWrap}>
          {empty ? (
            <EmptyState
              title={t("tenants.empty.title")}
              reason={t("tenants.empty.reason")}
              actions={<Button variant="primary" onClick={() => setOnboarding(true)}>{t("tenants.create")}</Button>}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title={q.trim() ? t("tenants.search.none", { q: q.trim() }) : t("tenants.view.empty")}
              reason={q.trim() ? t("tenants.search.noneReason") : t("tenants.view.emptyReason")}
              actions={<Button onClick={resetFilters}>{t("tenants.rail.reset")}</Button>}
            />
          ) : (
            <Table label={t("tenants.table")} rows={rows} rowId={(o: Org) => o.id} selected={effectiveSel} onSelect={select} mobileLayout="compact" density="compact" columns={columns} />
          )}
        </div>
      }
      full={full}
      onFull={setFull}
      onSelect={select}
      record={selected ? {
        id: selected.id,
        label: selected.name,
        title: selected.name,
        meta: selected.slug,
        onClose: dismiss,
        returnFocus: () => rowById(tableRef.current, selected.id),
        children: (
          <TenantConsolePanel
            key={selected.id}
            org={selected}
            health={health.get(selected.id)}
            onIssued={setIssued}
            onRecorded={record}
            onRemoved={(r) => { dismiss(); record(r); }}
            onOpenSupport={onOpenSupport}
          />
        ),
      } : null}
      foot={!empty && rows.length > 0 ? <ListSummaryFooter start={<strong>{t("tenants.foot.summary", { shown: rows.length, active: counts.active })}</strong>} end={counts.attention > 0 ? t("tenants.foot.attention", { count: counts.attention }) : undefined} /> : undefined}
      statusSegments={list.data ? [
        { id: "scope", content: t("shell.hub.platform"), tone: "strong" },
        { id: "tab", content: t("tenants.tab.tenants") },
        { id: "count", content: t("tenants.status.count", { shown: rows.length, total: all.length }) },
        ...(selected ? [{ id: "sel", content: selected.name }] : []),
      ] : null}
      overlays={
        <TenantConsoleOverlays
          onboarding={onboarding}
          lookupOpen={lookupOpen}
          issued={issued}
          existing={list.data ?? []}
          onCloseOnboarding={() => setOnboarding(false)}
          onCloseLookup={() => setLookupOpen(false)}
          onIssued={setIssued}
          onSelectOrg={(id) => select(id)}
          onRecorded={record}
        />
      }
    />
  );
}
