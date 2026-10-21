// The roster's column choice (E1-views): which optional columns show and in what order. employee number and name are fixed first.
export const OPTIONAL_COLUMNS = ["entity", "unit", "position", "type", "hired", "status", "next"] as const;
export type ColumnId = (typeof OPTIONAL_COLUMNS)[number];

/** A stored choice read back: unknown ids dropped, duplicates dropped; nothing stored = every column in its order. */
export function parseColumns(raw: string | null | undefined): ColumnId[] {
  if (!raw) return [...OPTIONAL_COLUMNS];
  const seen = new Set<string>();
  const ids = raw.split(",").filter((x): x is ColumnId => (OPTIONAL_COLUMNS as readonly string[]).includes(x) && !seen.has(x) && Boolean(seen.add(x)));
  return ids.length ? ids : [...OPTIONAL_COLUMNS];
}

/** Moves one shown column up or down by one place (Alt+↑↓ or the buttons; never by dragging alone, WCAG 2.5.7). */
export function moveColumn(shown: readonly ColumnId[], id: ColumnId, by: -1 | 1): ColumnId[] {
  const at = shown.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= shown.length) return [...shown];
  const out = [...shown];
  [out[at], out[to]] = [out[to]!, out[at]!];
  return out;
}

/** Turns one optional column on (at the end) or off. */
export const toggleColumn = (shown: readonly ColumnId[], id: ColumnId): ColumnId[] => (shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id]);
