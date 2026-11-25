// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { rosterWindowQuery } from "../api/roster";
import { FOCUS_SETTLE_MS, editable, rowById } from "../../../ui/long-table/row-keys";
import { NO_SELECTION, type Selection } from "../../../ui/long-table/selection";
import { focusSoon } from "../../../lib/react/announce";
import { columnSelection } from "../../../lib/react/use-column-selection";
import { usePrefetch } from "../../../lib/react/prefetch";
import { todayKst } from "../../../lib/pure/today";
import { useReasonCodesReady } from "../../../lib/reason-codes";
import { unitsQuery } from "../../../reference/org/api";
import { employeeQuery } from "../api";
import { activeView, exactNumber, joinReview, parseIds, parseReview, parseStatus, type Review, type StatusView } from "../domain/roster";
import { parseOrder, type RosterOrder } from "../domain/roster-order";
import { useRoster } from "./use-roster";
import { useRosterColumns } from "./use-roster-columns";
import { whenRowsDrawn } from "./rows-drawn";
import type { ExitView } from "./exit-tabs";

const route = getRouteApi("/app/people");

/**
 * Where the roster was, kept in memory (never the URL or storage: the search may be a person's name) so Back from
 * a record restores the search, the scroll position and the row the user came from. Keyed by the URL filters.
 * the scroll is restored while the loaded pages are still cached (gcTime, 5 min); past that only page 1
 * comes back and the position is clamped to it.
 */
let memory: { key: string; q: string; top: number; row: string | null } | null = null;
const listened = new WeakSet<HTMLElement>();
const remember = (key: string, q: string, patch: Partial<NonNullable<typeof memory>>) => void (memory = { ...(memory?.key === key ? memory : { key, q, top: 0, row: null }), ...patch });

/** URL, reads, commands and restoration shared by the roster screen. */
export function useRosterScreen() {
  const contractWindow = useQuery(rosterWindowQuery);
  const soonDays = contractWindow.isError ? undefined : contractWindow.data;
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const today = todayKst();
  const status = parseStatus(search.status);
  const review = parseReview(search.review);
  const { unit } = search;
  const ids = parseIds(search.ids);
  const { sel: open, sel2: openUnit, select, selectRelated, full, expand, restore } = columnSelection(search, navigate);
  const unitTrigger = useRef<HTMLButtonElement | null>(null);
  const unitItems = useQuery({ ...unitsQuery, enabled: Boolean(openUnit) }).data?.items ?? [];
  const selectedUnit = openUnit ? unitItems.find((u) => u.id === openUnit) : undefined;
  const sort = parseOrder(search.sort);
  const key = JSON.stringify([status, review, unit ?? null, ids, sort]);
  const [back] = useState(() => (memory?.key === key ? memory : null));
  const [q, setQ] = useState(back?.q ?? "");
  const [jump, setJump] = useState<string | null>(null);
  const [exitView, setExitView] = useState<ExitView>("kept");
  // The search sits in the filter band, mounted before the table hands it there.
  const [findSlot, setFindSlot] = useState<HTMLElement | null>(null);
  const [sel, setSel] = useState<Selection>(NO_SELECTION);
  // The last bulk appointment's record, until the filters change.
  const [recorded, setRecorded] = useState<string>();
  // The last bulk appointment, rescindable as one.
  const [batch, setBatch] = useState<{ id: string; count: number } | null>(null);
  const [rescinding, setRescinding] = useState(false);
  // The rescission sheet's reasons, read before its button shows, so nothing lands under the pointer when it opens.
  const rescindReady = useReasonCodesReady(batch ? "lifecycle_cancel" : null);
  const r = useRoster({ status, review, unit, ...(ids.length > 0 ? { ids } : {}), q, sort }, soonDays, !contractWindow.isPending);
  const view = useRosterColumns();
  const prefetch = usePrefetch();
  // The memory always describes the current filters (a new filter starts at the top).
  useEffect(() => remember(key, q, { q }), [key, q]);

  const setFilter = (f: { status?: StatusView; review?: Review[]; unit?: string | null; ids?: string | null; sort?: RosterOrder }) => {
    // A select-all selection is a saved query: a new filter would silently mean other people.
    if (sel.kind === "all") setSel(NO_SELECTION);
    setRecorded(undefined);
    void navigate({
      search: (prev) => ({
        ...prev,
        sel: undefined,
        sel2: undefined,
        ...(f.status && { status: f.status === "current" ? undefined : f.status }),
        ...(f.review && { review: joinReview(f.review) }),
        ...(f.unit !== undefined && { unit: f.unit ?? undefined }),
        ...(f.ids !== undefined && { ids: f.ids ?? undefined }),
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
    void navigate({ search: (prev) => ({ ...prev, sel: undefined, sel2: undefined }), replace: true });
  };
  const reset = () => {
    setSel(NO_SELECTION);
    find("");
    setFilter({ status: "current", review: [], unit: null, ids: null });
    focusSoon("people-title");
  };
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
    // The row is focused a frame after the scroll, once the grid has seen it: focus re-applies the grid's last seen position.
    return whenRowsDrawn(el, () => {
      restored.current = true;
      el.scrollTop = back.top;
      if (back.row) requestAnimationFrame(() => {
        // A delayed arrival read must not take focus from a search the user already started.
        if (!editable(document.activeElement)) rowById(el, back.row!)?.focus();
      });
    });
  }, [back, rowCount]);
  const scrollRef = (el: HTMLElement | null) => {
    if (el && !listened.has(el)) {
      listened.add(el);
      el.addEventListener("scroll", () => memory && (memory.top = el.scrollTop), { passive: true });
    }
    scroller.current = el;
  };

  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onRowFocus = (id: string) => {
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      prefetch(employeeQuery(id));
      remember(key, q, { row: id });
    }, FOCUS_SETTLE_MS);
  };

  const filtered = Boolean(q || unit || ids.length || status !== "current" || review.length);
  const customFilters = Boolean(q || unit || ids.length || !activeView(status, review));
  // People who share a name keep it as written: said once, and told apart by number, placement and dates.
  const sameName = q && r.rows.length > 1 && r.rows.every((e) => e.name === r.rows[0]!.name) ? r.rows.length : 0;
  return {
    contractWindow, soonDays, search, navigate, today, status, review, unit, ids,
    open, openUnit, select, selectRelated, full, expand, restore, unitTrigger, unitItems, selectedUnit,
    sort, q, exitView, setExitView, findSlot, setFindSlot, sel, setSel,
    recorded, batch, setBatch, rescinding, setRescinding, setRecorded, rescindReady,
    r, view, prefetch, setFilter, find, reset, closePaste, bulkDone, openRecord,
    scroller, rowCount, scrollRef, onRowFocus, filtered, customFilters, sameName,
    onRowAction: (id: string) => (id === open ? openRecord(id) : (remember(key, q, { row: id }), select(id))),
  };
}
