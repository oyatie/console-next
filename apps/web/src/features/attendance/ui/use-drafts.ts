// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { session } from "../api";
import { DRAFT_OWNER, LEGACY_ATTENDANCE_PREFIX, draftKey, registerDraft } from "../../../lib/react/draft-owner";
import { splitKey, type Draft, type Drafts } from "../domain/grid";

type People = readonly { employee_id: string; name: string }[];

/**
 * The grid's unsaved cells, kept in this tab (spec §1.6: drafts survive a reload in the tab; offline they stay here),
 * with ⌘Z / ⌘Y over draft changes only. A save clears the saved cells; a refused cell stays a draft.
 */
export function useDrafts(scope: string, people: People) {
  const principal = useSyncExternalStore(session.subscribe, () => session.principal, () => session.principal);
  const [state, setState] = useState(() => ({ scope, principal, ...readDrafts(scope), past: [] as Drafts[], future: [] as Drafts[] }));
  const [storage, setStorage] = useState<{ scope: string; problem: Problem }>({ scope, problem: null });
  // Another month or unit: its own drafts (set during render, so the grid never draws the old scope's drafts).
  if (state.scope !== scope || state.principal !== principal) setState({ scope, principal, ...readDrafts(scope), past: [], future: [] });
  const { scope: loadedScope, principal: loadedPrincipal, now: storedDrafts, readProblem } = state;
  useLayoutEffect(() => {
    if (principal && loadedPrincipal === principal && loadedScope === scope) registerGrid(scope, storedDrafts, principal, people);
  }, [scope, loadedScope, principal, loadedPrincipal, storedDrafts, people]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active && loadedScope === scope && loadedPrincipal === principal && session.principal === principal) {
        setStorage({ scope, problem: saveDrafts(scope, { now: storedDrafts, readProblem }, principal, people) });
      }
    });
    return () => { active = false; };
  }, [scope, loadedScope, principal, loadedPrincipal, storedDrafts, readProblem, people]);
  const set = useCallback((next: Drafts) => setState((s) => ({ ...s, now: next, past: [...s.past.slice(-49), s.now], future: [] })), []);
  const put = useCallback((key: string, d: Draft | null) => setState((s) => {
    const now = { ...s.now };
    if (d === null) delete now[key];
    else now[key] = d;
    return { ...s, now, past: [...s.past.slice(-49), s.now], future: [] };
  }), []);
  // The scope on screen now (null once this store is gone), for a write that names its own scope: a child unmounting
  // with an old closure runs after this store has moved to another scope, or after it has unmounted (its children's
  // cleanups run after its own), when a put would be lost.
  const live = useRef<string | null>(scope);
  useLayoutEffect(() => {
    live.current = scope;
  });
  useEffect(() => () => { live.current = null; }, []);
  /**
   * A draft of the scope it was typed in: put when that scope is on screen, else written to that scope's own drafts
   * (the view moved on while typing), never into the scope on screen now. A problem means it was not kept.
   */
  const keep = useCallback((at: string, key: string, d: Draft): Problem => {
    if (!principal || session.principal !== principal) return "unavailable";
    return at === live.current ? (put(key, d), null) : keepDraft(at, key, d, principal, people);
  }, [put, principal, people]);
  const undo = useCallback(() => setState((s) => (s.past.length ? { ...s, now: s.past.at(-1)!, past: s.past.slice(0, -1), future: [s.now, ...s.future] } : s)), []);
  const redo = useCallback(() => setState((s) => (s.future.length ? { ...s, now: s.future[0]!, past: [...s.past, s.now], future: s.future.slice(1) } : s)), []);
  /** Drop the cells a save wrote (they are no longer drafts). */
  const saved = useCallback((keys: readonly string[]) => setState((s) => {
    const now = { ...s.now };
    for (const k of keys) delete now[k];
    return { ...s, now, past: [], future: [] };
  }), []);
  return { scope, problem: state.readProblem ?? (storage.scope === scope ? storage.problem : null), drafts: state.now, set, put, keep, undo, redo, saved };
}


type Problem = "unreadable" | "unavailable" | null;
type Stored = { now: Drafts; readProblem: Problem };
const key = (scope: string, principal: string) => draftKey(principal, "attendance", scope, "grid");

function registerGrid(scope: string, drafts: Drafts, principal: string, people: People = []) {
  const names = new Map(people.map(p => [p.employee_id, p.name]));
  registerDraft(key(scope, principal), { principal, text: () => Object.entries(drafts).map(([cell, d]) => {
    const { employee_id, work_date } = splitKey(cell);
    return [work_date, names.get(employee_id), d.value].filter(value => value !== undefined).join(" · ");
  }).join("\n") });
}

export function readDrafts(scope: string, principal = session.principal): Stored {
  let raw: string | null;
  let readProblem: Problem = null;
  try {
    const legacy = LEGACY_ATTENDANCE_PREFIX + scope;
    const old = sessionStorage.getItem(legacy);
    raw = principal ? sessionStorage.getItem(key(scope, principal)) : null;
    if (old !== null) {
      if (principal && sessionStorage.getItem(DRAFT_OWNER) === principal && raw === null) {
        raw = old;
        try { sessionStorage.setItem(key(scope, principal), old); }
        catch { readProblem = "unavailable"; }
      }
      if (!readProblem) sessionStorage.removeItem(legacy);
    }
  } catch {
    return { now: {}, readProblem: "unavailable" };
  }
  if (raw === null) return { now: {}, readProblem: null };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((d: unknown) =>
      d && typeof d === "object" && "value" in d && typeof d.value === "string" && "base" in d && (d.base === null || typeof d.base === "string"))) {
      const now = value as Drafts;
      if (principal) registerGrid(scope, now, principal);
      return { now, readProblem };
    }
  } catch {
    return { now: {}, readProblem: "unreadable" };
  }
  return { now: {}, readProblem: "unreadable" };
}

/** One draft added to a scope that is not on screen, in its own stored drafts; an unreadable original is left alone. */
export function keepDraft(scope: string, cell: string, d: Draft, principal = session.principal, people: People = []): Problem {
  if (!principal || session.principal !== principal) return "unavailable";
  const stored = readDrafts(scope, principal);
  return stored.readProblem ?? saveDrafts(scope, { now: { ...stored.now, [cell]: d }, readProblem: null }, principal, people);
}

export function saveDrafts(scope: string, state: Stored, principal = session.principal, people: People = []): Problem {
  if (!principal || session.principal !== principal) return "unavailable";
  registerGrid(scope, state.now, principal, people);
  // An unreadable original must survive edits and empty-draft cleanup.
  if (state.readProblem) return state.readProblem;
  try {
    if (Object.keys(state.now).length) sessionStorage.setItem(key(scope, principal), JSON.stringify(state.now));
    else sessionStorage.removeItem(key(scope, principal));
    return null;
  } catch {
    return "unavailable";
  }
}
