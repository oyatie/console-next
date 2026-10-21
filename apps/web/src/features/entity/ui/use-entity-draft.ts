import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { todayKst } from "../../../lib/pure/today";
import { codesQuery, documentQuery } from "../api";
import { emptyDraft, missing, problems, type Draft, type Section } from "../domain/draft";

/**
 * The register sheet's state: the draft, the kept certificate it is typed beside, and whether required gaps
 * are shown yet (only after a save attempt, so an empty form is not a wall of red). Nothing is read from the
 * certificate: the admin types every field (decisions #16).
 */
export function useEntityDraft(seed?: Partial<Draft>, persist?: { key: string; entry: unknown }) {
  // worst-case-30: under `persist` the draft is kept per browser history entry (this tab's session storage, keyed by the
  // entry), so it survives a reload and a step back or forward; opening the screen anew (a new entry) starts empty.
  const [kept] = useState(() => (persist ? readKept(`${persist.key}:${String(persist.entry)}`) : null));
  const [draft, setDraft] = useState<Draft>(() => ({ ...emptyDraft(seed?.scope), ...seed, ...kept?.draft }));
  const [docId, setDocId] = useState<string | null>(kept?.docId ?? null);
  const key = persist?.key;
  const entry = persist?.entry;
  useEffect(() => {
    // Written again on each step's new entry too (it is stamped with the entry it belongs to).
    if (key) writeKept(`${key}:${String(entry)}`, { draft, docId });
  }, [key, entry, draft, docId]);
  const [showRequired, setShowRequired] = useState(false);
  const today = todayKst();
  const brnClasses = useQuery({ ...codesQuery("brn_classification", ""), retry: false }).data?.items ?? [];

  const set = <K extends keyof Draft>(_section: Section, k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const docQ = useQuery({ ...documentQuery(docId ?? ""), enabled: docId !== null });
  const doc = docId ? (docQ.data ?? null) : null;
  const withDocument = Boolean(doc);
  return {
    draft,
    brnClasses,
    set,
    doc,
    /** The uploaded document's id (the pane uploads; this hook reads it). */
    setDocId,
    today,
    showRequired,
    revealRequired: () => setShowRequired(true),
    /** Forget the kept draft (after it was saved). */
    forget: () => key && forgetAll(key),
    missing: missing(draft, withDocument),
    problems: problems(draft, { withDocument, showRequired, today }),
  };
}
export type EntityDraftState = ReturnType<typeof useEntityDraft>;

type Kept = { draft: Draft; docId: string | null };
// Session storage can be missing or refuse (private mode, blocked site data): the draft then lives in memory only.
function readKept(key: string): Kept | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Kept) : null;
  } catch {
    return null;
  }
}
function writeKept(key: string, v: Kept) {
  try {
    sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* memory only */
  }
}
/** Every entry's kept draft under `prefix` (after the save). */
function forgetAll(prefix: string) {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(`${prefix}:`)) sessionStorage.removeItem(k);
  } catch {
    /* nothing kept */
  }
}
