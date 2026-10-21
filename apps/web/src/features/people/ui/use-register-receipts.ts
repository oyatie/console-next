// The registrations of this tab still open to undo (spec E3 "undo", setup phase): newest first, kept in memory
// so the roster's toast outlives the sheet that made them. memory only, a reload forgets them (the
// person stays registered and is removed from the card instead); a server batch id would make them durable.
import { useSyncExternalStore } from "react";
import type { components } from "@console/api/schema";

export type Registered = { id: string; name: string; number: string; updatedAt: string; undoable: boolean; warnings?: components["schemas"]["EmployeeCreateWarning"][] };

let list: readonly Registered[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const receipts = {
  push: (r: Registered) => ((list = [r, ...list.filter((x) => x.id !== r.id)].slice(0, 5)), emit()),
  drop: (id: string) => ((list = list.filter((x) => x.id !== id)), emit()),
  clear: () => ((list = []), emit()),
};

export const useReceipts = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => list,
  );
