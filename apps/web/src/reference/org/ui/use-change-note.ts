import { useSyncExternalStore } from "react";

/** The last org change made from the chart: what it did, and the record it is (org-19). */
export type ChangeNote = { id: string; code: string; message: string };

let current: ChangeNote | undefined;
const listeners = new Set<() => void>();
/** Shows (or, with nothing, clears) the receipt on the chart. One at a time: the newest replaces it. */
export function noteChange(n?: ChangeNote) {
  current = n;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** The receipt the chart shows, if any. */
export const useChangeNote = () => useSyncExternalStore(subscribe, () => current, () => undefined);
