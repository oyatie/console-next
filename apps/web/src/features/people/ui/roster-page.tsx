import { useEffect, useRef, useState, type ReactNode } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Receipt } from "../../../ui/receipt/receipt";
import { editable } from "../../../ui/long-table/row-keys";
import { NO_SELECTION, type Selection } from "../../../ui/long-table/selection";
import { focusSoon } from "../../../lib/react/announce";
import { usePrefetch } from "../../../lib/react/prefetch";
import { freshOnOpen } from "../../../lib/query";
import { todayKst } from "../../../lib/pure/today";
import { useReasonCodesReady } from "../../../lib/reason-codes";
import { employeeQuery } from "../api";
import { exactNumber, headcount, joinReview, parseReview, parseSort, parseStatus, type Review, type RosterSort, type StatusView } from "../domain/roster";
import { BulkRescind } from "./bulk-rescind";
import { BulkSheet } from "./bulk-sheet";
import { RosterBulk } from "./roster-bulk";
import { RosterTable } from "./roster-table";
import { RosterFilters } from "./roster-filters";
import { RosterPanel } from "./roster-panel";
import { BULK_MAX, useRoster } from "./use-roster";
import { PeopleJump } from "./people-jump";
import { RegisterExport } from "./register-export";
import { RosterFirstRun } from "./roster-first-run";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup } from "../../../lib/react/query-view";
import { RosterEmpty } from "./roster-empty";
import { RosterColumns } from "./roster-columns";
import { useRosterColumns } from "./use-roster-columns";
import { Band } from "../../../ui/band/band";
import { Banner } from "../../../ui/banner/banner";
import { entitiesRef } from "../../../reference/entity/api";
import { unitsQuery } from "../../../reference/org/api";
import s from "./roster.module.css";
import { useCan } from "../../../reference/authz/ui/use-can";
import { RosterExport } from "./roster-export";
import { RosterFoot } from "./roster-foot";
import { RosterHead } from "./roster-head";
import { ExitTabs, VoidedList, type ExitView } from "./exit-tabs";

const route = getRouteApi("/app/people");
/** Focus that rests on a row this long counts as a stop (J/K held down does not read every person it passes). */
const FOCUS_SETTLE_MS = 150;

/**
 * Where the roster was, kept in memory (never the URL or storage: the search may be a person's name) so Back from
 * a record restores the search, the scroll position and the row the user came from. Keyed by the URL filters.
 * the scroll is restored while the loaded pages are still cached (gcTime, 5 min); past that only page 1
 * comes back and the position is clamped to it.
 */
let memory: { key: string; q: string; top: number; row: string | null } | null = null;
const listened = new WeakSet<HTMLElement>();
const remember = (key: string, q: string, patch: Partial<NonNullable<typeof memory>>) => void (memory = { ...(memory?.key === key ? memory : { key, q, top: 0, row: null }), ...patch });

/** The people list: status and attention chips, a virtualized server-paged table, and the selected person beside it. */
export function RosterPage({ manage, scoped = false, switcher }: { manage: boolean; scoped?: boolean; switcher?: ReactNode }) {
  // Resolve the chosen scope before drawing its controls; cached structure can predate the unit just created.
  const entities = freshOnOpen(useQuery({ ...entitiesRef, refetchOnMount: "always" }));
  const units = freshOnOpen(useQuery({ ...unitsQuery, refetchOnMount: "always" }));
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const today = todayKst();
  const status = parseStatus(search.status);
  const review = parseReview(search.review);
  const { unit, sel: open } = search;
  const sort = parseSort(search.sort);
  const key = JSON.stringify([status, review, unit ?? null, sort]);
  const [back] = useState(() => (memory?.key === key ? memory : null));
  const [q, setQ] = useState(back?.q ?? "");
  const [jump, setJump] = useState<string | null>(null);
  const [exitView, setExitView] = useState<ExitView>("kept");
  // The search sits in the filter band (E1), mounted before the table hands it there.
  const [findSlot, setFindSlot] = useState<HTMLElement | null>(null);
  const [sel, setSel] = useState<Selection>(NO_SELECTION);
  // The last bulk appointment's record, until the filters change.
  const [recorded, setRecorded] = useState<string>();
  // The last bulk appointment, rescindable as one (BW-11).
  const [batch, setBatch] = useState<{ id: string; count: number } | null>(null);
  const [rescinding, setRescinding] = useState(false);
  // The rescission sheet's reasons, read before its button shows, so nothing lands under the pointer when it opens.
  const rescindReady = useReasonCodesReady(batch ? "lifecycle_cancel" : null);
  const r = useRoster({ status, review, unit, q, sort });
  const view = useRosterColumns();
  const can = useCan();
  const prefetch = usePrefetch();
  // The memory always describes the current filters (a new filter starts at the top).
  useEffect(() => void (memory = memory?.key === key ? { ...memory, q } : { key, q, top: 0, row: null }), [key, q]);

  const setFilter = (f: { status?: StatusView; review?: Review[]; unit?: string | null; sort?: RosterSort }) => {
    // A select-all selection is a saved query: a new filter would silently mean other people.
    if (sel.kind === "all") setSel(NO_SELECTION);
    setRecorded(undefined);
    void navigate({
      search: (prev) => ({
        ...prev,
        sel: undefined,
        ...(f.status && { status: f.status === "current" ? undefined : f.status }),
        ...(f.review && { review: joinReview(f.review) }),
        ...(f.unit !== undefined && { unit: f.unit ?? undefined }),
        ...(f.sort && { sort: f.sort === "name" ? undefined : f.sort }),
      }),
      replace: true,
    });
  };
  const find = (text: string) => {
    const v = text.trim();
    if (sel.kind === "all" && v !== q) setSel(NO_SELECTION);
    setQ(v);
    setJump(v || null);
    remember(key, q, { q: v, top: 0 });
    void navigate({ search: (prev) => ({ ...prev, sel: undefined }), replace: true });
  };
  const reset = () => {
    setSel(NO_SELECTION);
    find("");
    setFilter({ status: "current", review: [], unit: null });
  };
  const select = (id: string | undefined) => void navigate({ search: (prev) => ({ ...prev, sel: id }), replace: true });
  const closePaste = () => void navigate({ search: (prev) => ({ ...prev, bulk: undefined }), replace: true });
  const bulkDone = (message: string, recordedBatch?: { id: string; count: number }) => {
    setSel(NO_SELECTION);
    setRecorded(message);
    setBatch(recordedBatch ?? null);
    if (search.bulk) closePaste();
    // The selection bar (and the control that had focus) goes with the selection: focus the page heading.
    focusSoon("people-title");
  };
  const openRecord = (id: string) => {
    remember(key, q, { row: id });
    void navigate({ to: "/people/$id", params: { id } });
  };

  // Enter on a search that is exactly one person's employee number opens that person.
  const hit = jump && jump === q && !r.loading ? exactNumber(r.rows, jump) : null;
  const hitId = hit?.id;
  useEffect(() => {
    if (hitId) void navigate({ to: "/people/$id", params: { id: hitId } });
  }, [hitId, navigate]);

  // Back from a record: the same scroll position, focus on the row the user left from.
  const scroller = useRef<HTMLElement | null>(null);
  const restored = useRef(false);
  const rowCount = r.rows.length;
  useEffect(() => {
    const el = scroller.current;
    if (restored.current || !back || !rowCount || !el) return;
    restored.current = true;
    el.scrollTop = back.top;
    if (back.row) requestAnimationFrame(() => {
      // A delayed arrival read must not take focus from a search the user already started.
      if (!editable(document.activeElement)) el.querySelector<HTMLElement>(`[data-key="${CSS.escape(back.row!)}"]`)?.focus();
    });
  }, [back, rowCount]);
  const scrollRef = (el: HTMLElement | null) => {
    if (el && !listened.has(el)) {
      listened.add(el);
      el.addEventListener("scroll", () => memory && (memory.top = el.scrollTop), { passive: true });
    }
    scroller.current = el;
  };

  // Esc closes the panel (not inside a field, where it clears the text) and focus goes back to that row.
  const split = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || editable(e.target) || !split.current?.contains(e.target as Node)) return;
      void navigate({ search: (prev) => ({ ...prev, sel: undefined }), replace: true });
      requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(open)}"]`)?.focus());
    };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [open, navigate]);

  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onRowFocus = (id: string) => {
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      prefetch(employeeQuery(id));
      remember(key, q, { row: id });
      if (open && id !== open) select(id); // the panel follows J/K
    }, FOCUS_SETTLE_MS);
  };

  const filtered = Boolean(q || unit || status !== "current" || review.length);
  // People who share a name keep it as written (E1-dup): said once, and told apart by number, placement and dates.
  const sameName = q && r.rows.length > 1 && r.rows.every((e) => e.name === r.rows[0]!.name) ? r.rows.length : 0;
  const empty = filtered ? (
    <RosterEmpty q={q} narrowed={Boolean(unit || status !== "current" || review.length)} exited={status === "EXITED"} manage={manage} onReset={reset} onExited={() => setFilter({ status: "EXITED", review: [], unit: null })} />
  ) : (
    <EmptyState title={t("people.empty.title")} reason={t("people.empty.reason")} actions={manage && <Link className="btn btn--primary" to="/people/new" search={{}}>{t("people.register")}</Link>} />
  );
  const total = r.total;
  // The first-run ways in are for a company with nobody at all (the starting and the exited counted, once their totals are
  // read); a current view that is empty while others exist is the table's own empty state, with its way to them.
  const context = readGroup([entities, units, r.list]);
  if (search.export === "register") return <RegisterExport onClose={() => void navigate({ search: (prev) => ({ ...prev, export: undefined }), replace: true })} />;
  return (
    <div className={s.page}>
      <RosterHead
        headcount={headcount(r.status.totals)}
        manage={manage}
        status={status}
        review={review}
        onView={(v) => setFilter({ status: v.status, review: v.review })}
        actions={can("excel_download") && <RosterExport query={r.query} total={total} />}
        switcher={switcher}
      />
      {/* BW-22: the server lists only this reader's branches' people; said once, above the filters. */}
      <RosterFilters
        status={status}
        review={review}
        unit={unit}
        sort={sort}
        counts={r}
        onChange={setFilter}
        findSlot={setFindSlot}
        density={view.density}
        onDensity={view.setDensity}
        tools={<RosterColumns shown={view.shown} onChange={view.set} density={view.density} onDensity={view.setDensity} />}
      />
      <QueryState q={context} layout="list">{() => <>
      <div className={s.notes}>
      {status === "EXITED" && <ExitTabs view={exitView} kept={r.status.totals.EXITED} onView={setExitView} />}
      {scoped && <p className="muted">{t("roster.scope.branches")}</p>}
      {sameName > 1 && <div role="note"><Banner>{t("roster.sameName", { count: sameName, name: r.rows[0]!.name })}</Banner></div>}
      {recorded && (
        <Receipt
          state="recorded"
          message={recorded}
          actions={batch && manage && rescindReady && <Button variant="ghost" onClick={() => setRescinding(true)}>{t("bulk.rescind.open", { count: batch.count })}</Button>}
        />
      )}
      {rescinding && batch && <BulkRescind batchId={batch.id} count={batch.count} onClose={() => setRescinding(false)} onDone={(n) => (setRescinding(false), setBatch(null), setRecorded(t("bulk.rescind.done", { count: n })))} />}
      </div>
      {manage && search.bulk === "paste" && <BulkSheet source={{ paste: "" }} onClose={closePaste} onDone={bulkDone} />}
      {status === "EXITED" && exitView === "voided" ? <VoidedList /> : !r.loading && !r.list.error && !filtered && (r.status.totals.all ?? total) === 0 && !r.changed ? <RosterFirstRun /> : (
      <div ref={split} className={s.split} data-open={Boolean(open)}>
        <Band className={s.tableWrap}>
          <>
          {/* Under a failed read the table stays (its search lives in the band above), empty rather than claiming nobody. */}
          <RosterTable
              today={today}
              exited={status === "EXITED"}
              shown={view.shown}
              density={view.density}
              label={t("people.table")}
              rows={r.rows}
              total={total}
              hasMore={r.list.hasNextPage}
              loadingMore={r.list.isFetchingNextPage}
              onLoadMore={() => void (r.list.hasNextPage && !r.list.isFetchingNextPage && r.list.fetchNextPage())}
              loading={r.loading}
              empty={r.list.error && !r.list.data ? null : empty}
              onRowAction={(id) => (id === open ? openRecord(id) : (remember(key, q, { row: id }), select(id)))}
              onRowHover={(id) => prefetch(employeeQuery(id))}
              onRowFocus={onRowFocus}
              rowKeys={{ onOpen: openRecord }}
              find={{ label: t("roster.find"), onFind: find, defaultValue: q }}
              findSlot={findSlot}
              scrollRef={scrollRef}
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
        {open && <RosterPanel id={open} today={today} onClose={() => select(undefined)} />}
      </div>
      )}
      <RosterFoot
        shown={rowCount}
        total={total}
        changed={r.changed && (
          // A filter whose count moved since the rows were read (someone else's change): the rows stay, the way to re-read is here.
          <span className={s.changed} role="status"><Button onClick={() => void r.list.refetch()}>{t("roster.changed")}</Button></span>
        )}
      />
      <PeopleJump />
    </>}</QueryState>
    </div>
  );
}
