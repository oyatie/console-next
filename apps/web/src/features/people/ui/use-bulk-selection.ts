// The people a roster selection hands to the bulk workspace (spec E6): id → the name seen when picked, kept in
// memory between the roster and /people/bulk. memory only; a reload empties it and the page says how to
// pick again (a server-materialized selection, backend-followups EMP-UI, would make it a link).
import { useSyncExternalStore } from "react";

let picked: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export const bulkSelection = {
  set: (m: ReadonlyMap<string, string>) => ((picked = new Map(m)), listeners.forEach((l) => l())),
  drop: (id: string) => {
    const next = new Map(picked);
    next.delete(id);
    picked = next;
    listeners.forEach((l) => l());
  },
};

export const useBulkSelection = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => picked,
  );
