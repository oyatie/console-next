import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Draft, Drafts } from "../domain/grid";

/**
 * The grid's unsaved cells, kept in this tab (spec §1.6: drafts survive a reload in the tab; offline they stay here),
 * with ⌘Z / ⌘Y over draft changes only. A save clears the saved cells; a refused cell stays a draft.
 */
export function useDrafts(scope: string) {
  const [state, setState] = useState(() => ({ scope, ...readDrafts(scope), past: [] as Drafts[], future: [] as Drafts[] }));
  const [storage, setStorage] = useState<{ scope: string; problem: Problem }>({ scope, problem: null });
  // Another month or unit: its own drafts (set during render, so the grid never draws the old scope's drafts).
  if (state.scope !== scope) setState({ scope, ...readDrafts(scope), past: [], future: [] });
  const { scope: loadedScope, now: storedDrafts, readProblem } = state;
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active && loadedScope === scope) setStorage({ scope, problem: saveDrafts(scope, { now: storedDrafts, readProblem }) });
    });
    return () => { active = false; };
  }, [scope, loadedScope, storedDrafts, readProblem]);
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
  const keep = useCallback((at: string, key: string, d: Draft): Problem => (at === live.current ? (put(key, d), null) : keepDraft(at, key, d)), [put]);
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
const key = (scope: string) => `console.attendance.drafts:${scope}`;

export function readDrafts(scope: string): Stored {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(key(scope));
  } catch {
    return { now: {}, readProblem: "unavailable" };
  }
  if (raw === null) return { now: {}, readProblem: null };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((d: unknown) =>
      d && typeof d === "object" && "value" in d && typeof d.value === "string" && "base" in d && (d.base === null || typeof d.base === "string"))) {
      return { now: value as Drafts, readProblem: null };
    }
  } catch {
    return { now: {}, readProblem: "unreadable" };
  }
  return { now: {}, readProblem: "unreadable" };
}

/** One draft added to a scope that is not on screen, in its own stored drafts; an unreadable original is left alone. */
export function keepDraft(scope: string, cell: string, d: Draft): Problem {
  const stored = readDrafts(scope);
  return stored.readProblem ?? saveDrafts(scope, { now: { ...stored.now, [cell]: d }, readProblem: null });
}

export function saveDrafts(scope: string, state: Stored): Problem {
  // An unreadable original must survive edits and empty-draft cleanup.
  if (state.readProblem) return state.readProblem;
  try {
    if (Object.keys(state.now).length) sessionStorage.setItem(key(scope), JSON.stringify(state.now));
    else sessionStorage.removeItem(key(scope));
    return null;
  } catch {
    return "unavailable";
  }
}
