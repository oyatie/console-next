// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { session } from "@console/api";

type Fields = Record<string, string | null>;
type Problem = "unreadable" | "unavailable" | null;
const PREFIX = "console.draft:";
const OWNER = "console.draft.principal";
const active = new Map<string, { principal: string; text: () => string }>();

export const draftKey = (principal: string, route: string, record: string, form: string) => PREFIX + JSON.stringify([principal, route, record, form]);

/** Called before the new account's screen can render; an ended session still owns its drafts. */
export function syncDraftPrincipal(principal: string | null) {
  for (const [key, draft] of active) if (draft.principal !== principal) active.delete(key);
  try {
    if (principal !== null && sessionStorage.getItem(OWNER) === principal) return null;
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
    if (principal) sessionStorage.setItem(OWNER, principal);
    else sessionStorage.removeItem(OWNER);
    return null;
  } catch {
    // Storage may be blocked; account-scoped keys and the live principal still prevent disclosure.
    return "unavailable" as const;
  }
}

export function readDraft<T extends Fields>(key: string, initial: T): { base: T; yours: T; restored: boolean; problem: Problem } {
  const empty = { base: initial, yours: initial, restored: false };
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { ...empty, problem: null };
    const stored: unknown = JSON.parse(raw);
    const valid = (value: unknown): value is T => Boolean(value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === Object.keys(initial).length
      && Object.entries(initial).every(([k, v]) => Object.hasOwn(value, k)
        && (typeof (value as Fields)[k] === "string" || (v === null && (value as Fields)[k] === null))));
    if (stored && typeof stored === "object" && "base" in stored && "yours" in stored && valid(stored.base) && valid(stored.yours)) {
      return { base: stored.base, yours: stored.yours, restored: true, problem: null };
    }
    return { ...empty, problem: "unreadable" };
  } catch (e) {
    return { ...empty, problem: e instanceof SyntaxError ? "unreadable" : "unavailable" };
  }
}

/** Only mounted forms owned by the current account can contribute to the recovery clipboard. */
export function recoveryDraftText() {
  return [...active.values()].filter((d) => d.principal === session.principal).map((d) => d.text()).filter(Boolean).join("\n\n");
}

/** Per-tab base + input, owned by an account, route, record and form. */
export function useDraft<T extends Fields>(opts: { route: string; record: string; form: string; initial: T; text: (value: T) => string }) {
  const format = opts.text;
  const principal = useSyncExternalStore(session.subscribe, () => session.principal);
  const key = draftKey(principal ?? "", opts.route, opts.record, opts.form);
  const [state, setState] = useState(() => ({ key, ...readDraft(key, opts.initial) }));
  if (state.key !== key) setState({ key, ...readDraft(key, opts.initial) });
  const [writeProblem, setWriteProblem] = useState<Problem>(null);
  useLayoutEffect(() => {
    if (!principal) return;
    active.set(key, { principal, text: () => format(state.yours) });
    return () => { active.delete(key); };
  }, [key, principal, format, state.yours]);
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (!live || !principal || session.principal !== principal || state.key !== key || state.problem) return;
      try {
        if (JSON.stringify(state.base) === JSON.stringify(state.yours)) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify({ base: state.base, yours: state.yours }));
        setWriteProblem(null);
      } catch {
        setWriteProblem("unavailable");
      }
    });
    return () => { live = false; };
  }, [key, principal, state]);
  const discard = () => {
    try { sessionStorage.removeItem(key); } catch { setWriteProblem("unavailable"); }
    setState({ key, base: opts.initial, yours: opts.initial, restored: false, problem: null });
  };
  return {
    value: state.yours,
    set: (value: T) => setState((s) => ({ ...s, yours: value })),
    restored: state.restored,
    problem: state.problem ?? writeProblem,
    discard,
  };
}
