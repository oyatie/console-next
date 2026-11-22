// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { SlidersHorizontal, Upload } from "lucide-react";
import { chunk } from "../../../lib/chunk-guard";
import { EMPLOYMENT_TYPE, label } from "../../../lib/labels";
import { read } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { entitiesRef } from "../../../reference/entity/api";
import { unitsQuery } from "../../../reference/org/api";
import { unitPath } from "../../../reference/org/present";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Dialog } from "../../../ui/dialog";
import { EmptyState } from "../../../ui/empty-state";
import { IndexBar } from "../../../ui/index-bar/index-bar";
import { StatRow } from "../../../ui/key-value/key-value";
import { rowById } from "../../../ui/long-table/row-keys";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ListSummaryFooter } from "../../../ui/patterns/list-record-parts";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { WorklistSearchField } from "../../../ui/patterns/worklist-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { SortControl } from "../../../ui/sort-control/sort-control";
import { employeeQuery } from "../api";
import { fetchAllConsoleRows } from "../api/peek";
import { type RosterOrder } from "../domain/roster-order";
import { BulkRescind } from "./bulk-rescind";
import { BulkSheet } from "./bulk-sheet";
import { ExitTabs, VoidedList } from "./exit-tabs";
import { PeopleJump } from "./people-jump";
import { RosterBulk } from "./roster-bulk";
import { ConsoleColumnsBody } from "./roster-console-columns";
import { buildConsoleStatusSegments, buildStatItems, CHOSUNG, filterConsoleRows, toOrderField, type EmpType } from "./roster-console-data";
import { RosterConsoleRail } from "./roster-console-rail";
import { RosterEmpty } from "./roster-empty";
import { RosterFirstRun } from "./roster-first-run";
import { RosterTable } from "./roster-table";
import { RosterUnitPanel } from "./roster-unit-panel";
import { BULK_MAX } from "./use-roster";
import type { useRosterScreen } from "./use-roster-screen";
import s from "./roster.module.css";

const RosterConsolePanel = lazy(() => chunk(import("./roster-console-panel")).then(m => ({ default: m.RosterConsolePanel })));
const RegisterExport = lazy(() => chunk(import("./register-export")).then(m => ({ default: m.RegisterExport })));

type Employee = components["schemas"]["Employee"];
const EMPTY_EMPLOYEES: Employee[] = [];

export function RosterConsole({
  manage, scoped = false, notice, actions, tabs, screen,
}: {
  manage: boolean; scoped?: boolean; notice?: ReactNode; actions?: ReactNode; tabs?: ReactNode; screen: ReturnType<typeof useRosterScreen>;
}) {
  const {
    contractWindow, soonDays, search, navigate, today, status, review, unit, open, openUnit, select, selectRelated,
    full, expand, restore, unitTrigger, unitItems, selectedUnit, sort, q, exitView, setExitView, sel, setSel,
    recorded, batch, setBatch, rescinding, setRescinding, setRecorded, rescindReady, r, view, prefetch, setFilter,
    find, reset, closePaste, bulkDone, openRecord, scroller, scrollRef, onRowFocus, filtered, customFilters, sameName, onRowAction,
  } = screen;

  const consoleNavigate = useNavigate();
  const [colsOpen, setColsOpen] = useState(false);
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(() => new Set());
  const [empTypes, setEmpTypes] = useState<Set<EmpType>>(() => new Set());
  const [addressMissingOnly, setAddressMissingOnly] = useState(false);
  const [probationOnly, setProbationOnly] = useState(false);
  const [activeChosung, setActiveChosung] = useState<string | null>(null);
  const findInputRef = useRef<HTMLDivElement>(null);
  const entitiesQ = useQuery(entitiesRef);
  const unitsQ = useQuery(unitsQuery);
  const entities = entitiesQ.data?.items ?? [];
  const total = r.total;
  const hasClientFilter = empTypes.size > 0 || addressMissingOnly || probationOnly || activeChosung !== null;
  const firstOffset = (r.list.data?.pages[0] as { offset?: number } | undefined)?.offset ?? 0;
  const needsFullRoster =
    hasClientFilter &&
    !r.loading &&
    !r.list.isError &&
    (firstOffset > 0 || Boolean(r.list.hasNextPage) || (total !== undefined && r.rows.length < total));
  const fullRoster = useQuery({
    ...read("/api/v1/employees", () => fetchAllConsoleRows(r.query), { ...r.query, scope: "console-full" }),
    enabled: needsFullRoster,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const sourceRows = needsFullRoster ? (fullRoster.data ?? EMPTY_EMPLOYEES) : r.rows;
  const displayedRows = useMemo(
    () => filterConsoleRows(sourceRows, { empTypes, addressMissingOnly, probationOnly, activeChosung }),
    [sourceRows, empTypes, addressMissingOnly, probationOnly, activeChosung],
  );

  if (search.export === "register") {
    return (
      <Suspense fallback={<ReadSkeleton layout="form" />}>
        <RegisterExport onClose={() => void navigate({ search: prev => ({ ...prev, export: undefined }), replace: true })} />
      </Suspense>
    );
  }

  const voided = status === "EXITED" && exitView === "voided";
  const firstRun = !r.loading && !r.list.error && !filtered && (r.status.totals.all ?? total) === 0 && !r.changed;
  const resetAll = () => { setEmpTypes(new Set()); setAddressMissingOnly(false); setProbationOnly(false); setActiveChosung(null); reset(); };
  const toggleEntityExpand = (id: string) => setExpandedEntities(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const activeFilterCount = (unit ? 1 : 0) + empTypes.size + review.length + (addressMissingOnly ? 1 : 0) + (probationOnly ? 1 : 0) + (activeChosung ? 1 : 0);
  const registerMissingCount = r.review.totals.register ?? 0;
  const contractSoonCount = r.review.totals.contractSoon ?? 0;
  const effectiveOffset = hasClientFilter ? 0 : firstOffset;
  const rowIndexMap = new Map(displayedRows.map((row, idx) => [row.id, effectiveOffset + idx + 1]));
  const rangeStart = displayedRows.length > 0 ? effectiveOffset + 1 : 0;
  const rangeEnd = displayedRows.length > 0 ? effectiveOffset + displayedRows.length : 0;
  const rangeTotal = hasClientFilter ? displayedRows.length : (total ?? displayedRows.length);
  const missingViewCount = displayedRows.filter(e => e.register_review_required || e.identity_review_required || !e.employment_type).length;
  const openPerson = open ? (sourceRows.find(e => e.id === open) ?? r.rows.find(e => e.id === open)) : undefined;
  const listQ = needsFullRoster && fullRoster.isError ? { ...r.list, error: fullRoster.error, data: undefined } : r.list;
  const order = toOrderField(sort);
  const sortControl = (
    <SortControl
      fields={[{ id: "name", label: t("people.col.name") }, { id: "employee_number", label: t("people.col.number") }, { id: "hire_date", label: t("people.col.hired") }]}
      field={order.field}
      direction={order.direction}
      onChange={next => setFilter({ sort: (next.direction === "desc" ? `-${next.field}` : next.field) as RosterOrder })}
    />
  );

  return (
    <ListRecord
      tabs={tabs}
      q={listQ}
      head={{
        title: t("roster.head.title"),
        titleId: "people-title",
        actions: (
          <div className={s.consoleTools}>
            <Button size="sm" variant="secondary" onClick={() => setColsOpen(true)}><SlidersHorizontal size={13} aria-hidden="true" />{t("people.tools.columns")}</Button>
            {manage ? <Link className={buttonClass("secondary", { size: "sm" })} to="/people/import"><Upload size={13} aria-hidden="true" />{t("roster.head.import")}</Link> : null}
            {actions}
          </div>
        ),
        primary: manage ? { id: "register", label: t("people.tools.add"), onAction: () => void consoleNavigate({ to: "/people/new", search: {} }) } : undefined,
      }}
      find={<div ref={findInputRef} className={s.consoleFind} data-list-find=""><WorklistSearchField label={t("people.find.placeholder")} value={q} onChange={find} /></div>}
      tools={<div className={s.consoleDesktopSort}>{sortControl}</div>}
      stats={!firstRun ? <StatRow label={t("people.stat.label")} items={buildStatItems({ status, review, statusTotals: r.status.totals, registerMissingCount, setFilter })} /> : undefined}
      rail={!firstRun ? <RosterConsoleRail entities={entities} facets={r.facets} unit={unit} expandedEntities={expandedEntities} toggleEntityExpand={toggleEntityExpand} empTypes={empTypes} setEmpTypes={setEmpTypes} review={review} registerMissingCount={registerMissingCount} addressMissingOnly={addressMissingOnly} setAddressMissingOnly={setAddressMissingOnly} probationOnly={probationOnly} setProbationOnly={setProbationOnly} soonDays={soonDays} contractSoonCount={contractSoonCount} activeFilterCount={activeFilterCount} q={q} status={status} setFilter={setFilter} resetAll={resetAll} phoneTools={sortControl} /> : undefined}
      indexBar={!voided && !firstRun ? <IndexBar label={t("people.index.label")} items={CHOSUNG.map(ch => ({ id: ch, label: ch }))} active={activeChosung} onSelect={setActiveChosung} range={displayedRows.length > 0 ? t("people.index.range", { start: rangeStart, end: rangeEnd, total: rangeTotal }) : undefined} prev={{ label: t("people.index.prev"), disabled: hasClientFilter || firstOffset <= 0, onPress: () => scroller.current?.scrollBy({ top: -400, behavior: "smooth" }) }} next={{ label: t("people.index.next"), disabled: hasClientFilter || !r.list.hasNextPage, onPress: () => { if (r.list.hasNextPage && !r.list.isFetchingNextPage) void r.list.fetchNextPage(); } }} /> : undefined}
      notes={
        <>
          {contractWindow.isError ? <QueryState q={contractWindow} inline>{() => null}</QueryState> : null}
          {status === "EXITED" ? <ExitTabs view={exitView} kept={r.status.totals.EXITED} onView={setExitView} /> : null}
          {notice || scoped ? <div className={s.notes}><bdi className="muted t-xs" role={notice ? "note" : undefined}>{notice}{notice && scoped ? " " : null}{scoped ? t("roster.scope.branches") : null}</bdi></div> : null}
          {sameName > 1 ? <RecordBannerBand tone="warn"><bdi role="note">{t("roster.sameName", { count: sameName, name: r.rows[0]!.name })}</bdi></RecordBannerBand> : null}
          {recorded ? <div className={s.notes}><Receipt state="recorded" message={recorded} actions={batch && manage && rescindReady ? <Button variant="ghost" onClick={() => setRescinding(true)}>{t("bulk.rescind.open", { count: batch.count })}</Button> : undefined} /></div> : null}
          {rescinding && batch ? <BulkRescind batchId={batch.id} count={batch.count} onClose={() => setRescinding(false)} onDone={n => { setRescinding(false); setBatch(null); setRecorded(t("bulk.rescind.done", { count: n })); }} /> : null}
        </>
      }
      list={
        voided ? <VoidedList /> : firstRun ? <RosterFirstRun /> : (
          <div className={s.tableWrap}>
            <RosterTable
              consoleMode
              mobileLayout="compact"
              hideCardSort
              activeRowId={open}
              sort={sort}
              onSort={nextSort => setFilter({ sort: nextSort })}
              today={today}
              soonDays={soonDays}
              exited={status === "EXITED"}
              shown={view.shown}
              density="compact"
              label={t("people.table")}
              rows={displayedRows}
              rowIndex={(row: Employee) => rowIndexMap.get(row.id) ?? 1}
              total={hasClientFilter ? displayedRows.length : total}
              hasMore={!hasClientFilter && !r.loading && r.list.hasNextPage}
              loadingMore={r.list.isFetchingNextPage}
              onLoadMore={() => void (r.list.hasNextPage && !r.list.isFetchingNextPage && r.list.fetchNextPage())}
              loading={r.loading || (needsFullRoster && fullRoster.isPending)}
              empty={(r.list.error && !r.list.data) || (needsFullRoster && fullRoster.isPending) ? null : (filtered || hasClientFilter) ? <RosterEmpty q={q} narrowed={Boolean(unit || status !== "current" || review.length || hasClientFilter)} exited={status === "EXITED"} manage={manage} onReset={customFilters || hasClientFilter ? resetAll : undefined} onExited={() => setFilter({ status: "EXITED", review: [], unit: null })} /> : <EmptyState title={t("people.empty.title")} reason={t("people.empty.reason")} actions={manage ? <Link className={buttonClass("primary")} to="/people/new" search={{}}>{t("people.register")}</Link> : undefined} />}
              onRowAction={onRowAction}
              onRowHover={id => prefetch(employeeQuery(id))}
              onRowFocus={onRowFocus}
              rowKeys={{ onOpen: openRecord }}
              scrollRef={scrollRef}
              scrollRestorationId="people-roster"
              {...(manage && {
                selection: sel, onSelectionChange: setSel,
                selectAllLimit: { max: BULK_MAX, reason: t("roster.selectAll.tooMany", { total }), remedy: t("roster.selectAll.remedy", { max: BULK_MAX }) },
                countUnit: "person" as const,
                selectionActions: <RosterBulk sel={sel} rows={displayedRows} total={total} query={r.query} onClear={setSel} onDone={bulkDone} />,
              })}
            />
          </div>
        )
      }
      full={full}
      onFull={on => (on ? expand() : restore())}
      onSelect={select}
      onOpen={openRecord}
      onFind={() => findInputRef.current?.querySelector("input")?.focus()}
      record={!voided && !firstRun && open ? { id: open, label: t("people.panel"), title: t("people.panel.cardTitle"), openInTab: openPerson ? { href: `/people/${open}`, label: openPerson.name } : undefined, closeLabel: t("roster.panel.close"), onClose: () => select(undefined), returnFocus: () => rowById(scroller.current, open), children: <Suspense fallback={<ReadSkeleton layout="record" />}><RosterConsolePanel id={open} today={today} unitTriggerRef={unitTrigger} onOpenUnit={selectRelated} /></Suspense> } : null}
      related={!voided && !firstRun && open && openUnit ? { id: openUnit, label: t("roster.panel.unit"), title: selectedUnit?.name ?? t("roster.panel.unit"), meta: selectedUnit ? unitPath(unitItems, selectedUnit) : undefined, actions: <Link className={buttonClass("secondary", { size: "sm" })} to="/org" search={{ sel: openUnit, focus: openUnit }}>{t("roster.panel.openOrg")}</Link>, onClose: () => selectRelated(undefined), returnFocus: () => unitTrigger.current, children: <RosterUnitPanel unitId={openUnit} units={unitsQ.data?.items ?? unitItems} /> } : null}
      foot={
        !voided && !firstRun && displayedRows.length > 0 ? (
          <ListSummaryFooter
            start={
              <>
                <strong>{t("people.foot.viewSummary", { count: displayedRows.length })}</strong>
                <bdi>{t("people.foot.typeCount", { label: label(EMPLOYMENT_TYPE, "REGULAR"), count: displayedRows.filter(e => e.employment_type === "REGULAR").length })}</bdi>
                <bdi>{t("people.foot.typeCount", { label: label(EMPLOYMENT_TYPE, "CONTRACT"), count: displayedRows.filter(e => e.employment_type === "CONTRACT").length })}</bdi>
                <bdi>{t("people.foot.typeCount", { label: label(EMPLOYMENT_TYPE, "PART_TIME"), count: displayedRows.filter(e => e.employment_type === "PART_TIME").length })}</bdi>
                {r.changed ? <Button size="sm" variant="ghost" onClick={() => void r.list.refetch()}>{t("roster.changed")}</Button> : null}
              </>
            }
            end={missingViewCount > 0 ? t("people.foot.missingCount", { count: missingViewCount }) : undefined}
          />
        ) : undefined
      }
      statusSegments={!r.loading && !r.list.error && !firstRun ? buildConsoleStatusSegments({ status, rangeTotal, displayedCount: displayedRows.length, rangeStart, rangeEnd, sel, openPerson, sort }) : null}
      overlays={
        <>
          <PeopleJump />
          {manage && search.bulk === "paste" ? <BulkSheet source={{ paste: "" }} onClose={closePaste} onDone={bulkDone} /> : null}
          <Dialog open={colsOpen} title={t("roster.columns.title")} size="sm" onClose={() => setColsOpen(false)}>
            <ConsoleColumnsBody shown={view.shown} onChange={view.set} onClose={() => setColsOpen(false)} />
          </Dialog>
        </>
      }
    />
  );
}
