// Bulk selection over a server list that is only partly loaded. Selecting "everything matching the filter" is a
// server-side selection (query + exclusions), never the loaded rows; the count shown is the server's total minus
// the exclusions, and per-row preconditions still apply when the command runs.

export type Selection =
  | { kind: "ids"; ids: ReadonlySet<string> }
  | { kind: "all"; excluded: ReadonlySet<string> };

export const NO_SELECTION: Selection = { kind: "ids", ids: new Set() };
export const ALL_MATCHING: Selection = { kind: "all", excluded: new Set() };

/** The keys React Aria should show as selected among the loaded rows. */
export function shownKeys(sel: Selection, loaded: readonly string[]): "all" | Set<string> {
  if (sel.kind === "ids") return new Set(sel.ids);
  return sel.excluded.size === 0 ? "all" : new Set(loaded.filter((id) => !sel.excluded.has(id)));
}

/**
 * React Aria's next selection, folded into ours. The header checkbox selects the loaded rows only (selecting
 * every match is the separate, explicit select-all-matching action); while everything matching is selected, unchecking
 * a row excludes it and clearing the header clears the whole selection.
 */
export function applyKeys(prev: Selection, keys: "all" | ReadonlySet<string | number>, loaded: readonly string[]): Selection {
  if (keys === "all") return prev.kind === "all" ? ALL_MATCHING : { kind: "ids", ids: new Set(loaded) };
  if (prev.kind === "all") return keys.size === 0 ? NO_SELECTION : { kind: "all", excluded: new Set(loaded.filter((id) => !keys.has(id))) };
  return { kind: "ids", ids: new Set([...keys].map(String)) };
}

/** How many rows the selection covers, given the server's total for the filter. */
export const selectionCount = (sel: Selection, total: number) => (sel.kind === "ids" ? sel.ids.size : Math.max(0, total - sel.excluded.size));

/** The command body: explicit ids, or the filter (the caller adds its query and pinned `as_of`) minus exclusions. */
export const toRequest = (sel: Selection) =>
  sel.kind === "ids" ? { ids: [...sel.ids] } : { all_matching: true as const, exclude_ids: [...sel.excluded] };
