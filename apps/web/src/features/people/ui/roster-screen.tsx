// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useElementScrollRestoration, useLocation, useRouter } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { ListRecord } from "../../../ui/patterns/list-record";
import { Receipt } from "../../../ui/receipt/receipt";
import { rowById } from "../../../ui/long-table/row-keys";
import { unitPath } from "../../../reference/org/present";
import { employeeQuery } from "../api";
import { BulkRescind, BulkSheet, RosterUnitPanel } from "./roster-actions";
import { RosterBulk } from "./roster-bulk";
import { RosterTable } from "./roster-table";
import { RosterFilters } from "./roster-filters";
import { BULK_MAX } from "./use-roster";
import { PeopleJump } from "./people-jump";
import { RosterFirstRun } from "./roster-first-run";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";

const RosterPanel = lazy(() => chunk(import("./roster-panel")).then(m => ({ default: m.RosterPanel })));
const RegisterExport = lazy(() => chunk(import("./register-export")).then(m => ({ default: m.RegisterExport })));
import { QueryState } from "../../../lib/react/query-state";
import { RosterEmpty } from "./roster-empty";
import { RosterColumns } from "./roster-columns";
import { Band } from "../../../ui/band/band";
import { Banner } from "../../../ui/banner/banner";
import s from "./roster.module.css";
import type { useRosterScreen } from "./use-roster-screen";

import { RosterFoot } from "./roster-foot";
import { useRosterHead } from "./roster-head";
import { ExitTabs, VoidedList } from "./exit-tabs";
import { RosterSavedViews } from "./roster-saved-views";

type RosterScreenProps = { manage: boolean; scoped?: boolean; switcher?: ReactNode; notice?: ReactNode; actions?: ReactNode; tabs?: ReactNode; screen: ReturnType<typeof useRosterScreen> };

function TableScrollRestoration({ id, grid }: { id: string; grid: RefObject<HTMLElement | null> }) {
  const router = useRouter();
  const key = useLocation({ select: location => location.state["__TSR_key"] });
  const entry = useElementScrollRestoration({ id });
  const applied = useRef<string | undefined>(undefined);
  const [, setRendered] = useState(0);
  useEffect(() => router.subscribe("onRendered", () => setRendered(value => value + 1)), [router]);
  useEffect(() => {
    if (!key || !entry || applied.current === key) return;
    const frame = requestAnimationFrame(() => {
      if (!grid.current) return;
      applied.current = key;
      grid.current.scrollTop = entry.scrollY;
    });
    return () => cancelAnimationFrame(frame);
  }, [entry, grid, key]);
  return null;
}

/** The people list: status and attention chips, a virtualized server-paged table, and the selected person beside it. */
export function RosterScreen({ manage, scoped = false, switcher, notice, screen, actions }: RosterScreenProps) {
  const {
    contractWindow, soonDays, search, navigate, today, status, review, unit,
    open, openUnit, select, selectRelated, full, expand, restore, unitTrigger, unitItems, selectedUnit,
    sort, q, exitView, setExitView, findSlot, setFindSlot, sel, setSel,
    recorded, batch, setBatch, rescinding, setRescinding, setRecorded, rescindReady,
    r, view, prefetch, setFilter, find, reset, viewFilters, applyView, closePaste, bulkDone, openRecord,
    scroller, rowCount, scrollRef, onRowFocus, filtered, customFilters, sameName, onRowAction,
  } = screen;
  const { tabs: views, ...head } = useRosterHead({ manage, soonDays, status, review, onView: v => setFilter({ status: v.status, review: v.review }), actions, switcher });
  const empty = filtered ? (
    <RosterEmpty q={q} narrowed={Boolean(unit || status !== "current" || review.length)} exited={status === "EXITED"} manage={manage} onReset={customFilters ? undefined : reset} onExited={() => setFilter({ status: "EXITED", review: [], unit: null })} />
  ) : (
    <EmptyState title={t("people.empty.title")} reason={t("people.empty.reason")} actions={manage && <Link className={buttonClass("primary")} to="/people/new" search={{}}>{t("people.register")}</Link>} />
  );
  const total = r.total;
  const voided = status === "EXITED" && exitView === "voided";
  const firstRun = !r.loading && !r.list.error && !filtered && (r.status.totals.all ?? total) === 0 && !r.changed;
  // The first-run ways in are for a company with nobody at all (the starting and the exited counted, once their totals are
  // read); a current view that is empty while others exist is the table's own empty state, with its way to them.
  if (search.export === "register") return <Suspense fallback={<ReadSkeleton layout="form" />}><RegisterExport onClose={() => void navigate({ search: (prev) => ({ ...prev, export: undefined }), replace: true })} /></Suspense>;
  return (
    <ListRecord q={r.list} head={head} views={views}
      filters={<>
      {/* The server lists only this reader's branches' people; said once, above the filters. */}
      <RosterFilters
        status={status}
        review={review}
        unit={unit}
        soonDays={soonDays}
        counts={r}
        onChange={setFilter}
        onReset={customFilters ? reset : undefined}
        findSlot={setFindSlot}
        density={view.density}
        onDensity={view.setDensity}
        tools={<><RosterColumns shown={view.shown} onChange={view.set} density={view.density} onDensity={view.setDensity} />
        {/* Kept in place when the list fails (its neighbours never slide), offered only with the list it filters. */}
        <RosterSavedViews unavailable={!!r.list.error && r.list.data === undefined} filters={viewFilters} onApply={applyView} /></>}
      />
      </>}
      notes={<>
      {contractWindow.isError && <QueryState q={contractWindow} inline>{() => null}</QueryState>}
      <div className={s.notes}>
      {status === "EXITED" && <ExitTabs view={exitView} kept={r.status.totals.EXITED} onView={setExitView} />}
      {(notice || scoped) && <p className="muted" role={notice ? "note" : undefined}>{notice}{notice && scoped && " "}{scoped && t("roster.scope.branches")}</p>}
      {sameName > 1 && <div role="note"><Banner>{t("roster.sameName", { count: sameName, name: r.rows[0]!.name })}</Banner></div>}
      {recorded && (
        <Receipt
          state="recorded"
          message={recorded}
          actions={batch && manage && rescindReady && <Button variant="ghost" onClick={() => setRescinding(true)}>{t("bulk.rescind.open", { count: batch.count })}</Button>}
        />
      )}
      {rescinding && batch && <Suspense fallback={null}><BulkRescind batchId={batch.id} count={batch.count} onClose={() => setRescinding(false)} onDone={(n) => (setRescinding(false), setBatch(null), setRecorded(t("bulk.rescind.done", { count: n })))} /></Suspense>}
      </div>
      </>}
      list={voided ? <VoidedList /> : firstRun ? <RosterFirstRun /> : (
        <Band className={s.tableWrap}>
          <>
          <TableScrollRestoration id="people-roster" grid={scroller} />
          {/* Under a failed read the table stays (its search lives in the band above), empty rather than claiming nobody. */}
          <RosterTable
              sort={sort}
              onSort={(nextSort) => setFilter({ sort: nextSort })}
              today={today}
              soonDays={soonDays}
              exited={status === "EXITED"}
              shown={view.shown}
              density={view.density}
              label={t("people.table")}
              rows={r.rows}
              total={total}
              hasMore={!r.loading && r.list.hasNextPage}
              loadingMore={r.list.isFetchingNextPage}
              onLoadMore={() => void (r.list.hasNextPage && !r.list.isFetchingNextPage && r.list.fetchNextPage())}
              loading={r.loading}
              empty={r.list.error && !r.list.data ? null : empty}
              onRowAction={onRowAction}
              onRowHover={(id) => prefetch(employeeQuery(id))}
              onRowFocus={onRowFocus}
              rowKeys={{ onOpen: openRecord }}
              find={{ label: t("roster.find"), onFind: find, defaultValue: q }}
              findSlot={findSlot}
              scrollRef={scrollRef}
              scrollRestorationId="people-roster"
              {...(manage && {
                selection: sel,
                onSelectionChange: setSel,
                selectAllLimit: { max: BULK_MAX, reason: t("roster.selectAll.tooMany", { total }), remedy: t("roster.selectAll.remedy", { max: BULK_MAX }) },
                countUnit: "person" as const,
                selectionActions: <RosterBulk sel={sel} rows={r.rows} total={total} query={r.query} onClear={setSel} onDone={bulkDone} />,
              })}
            />
          </>
        </Band>
      )}
      full={full} onFull={on => on ? expand() : restore()}
        onSelect={select}
        onOpen={openRecord}
        onFind={() => findSlot?.querySelector("input")?.focus()}
        record={!voided && !firstRun && open && { id: open, label: t("people.panel"), closeLabel: t("roster.panel.close"), onClose: () => select(undefined), returnFocus: () => rowById(scroller.current, open), children: <Suspense fallback={<ReadSkeleton layout="record" />}><RosterPanel id={open} today={today} unitTriggerRef={unitTrigger} onOpenUnit={selectRelated} /></Suspense> }}
        related={!voided && !firstRun && open && openUnit && { id: openUnit, label: t("roster.panel.unit"), title: selectedUnit?.name ?? t("roster.panel.unit"), crumb: selectedUnit ? unitPath(unitItems, selectedUnit) : undefined, expand: <Link className={buttonClass("secondary", { size: "sm" })} to="/org" search={{ sel: openUnit, focus: openUnit }}>{t("roster.panel.openOrg")}</Link>, onClose: () => selectRelated(undefined), returnFocus: () => unitTrigger.current, children: <Suspense fallback={<ReadSkeleton layout="record" />}><RosterUnitPanel unitId={openUnit} units={unitItems} /></Suspense> }}
      foot={<>
        <RosterFoot
          shown={rowCount}
          total={total}
          changed={r.changed && (
            // A filter whose count moved since the rows were read (someone else's change): the rows stay, the way to re-read is here.
            <span className={s.changed} role="status"><Button onClick={() => void r.list.refetch()}>{t("roster.changed")}</Button></span>
          )}
        />
        <PeopleJump />
      </>}
      overlays={manage && search.bulk === "paste" && <Suspense fallback={null}><BulkSheet source={{ paste: "" }} onClose={closePaste} onDone={bulkDone} /></Suspense>}
    />
  );
}
