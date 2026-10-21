// Range selection over a rows × columns grid: pure, so the grid and its callers agree. A corner is a row's key and a
// column's key, never an index: a re-sort, a filter, a live insert or a removal never moves a selection (or what is
// typed into it) onto another row. Indexes are only today's drawing of it (`rectIn`).
export type Cell = { row: string; col: string };
export type Range = { anchor: Cell; focus: Cell };
type Rect = { top: number; left: number; bottom: number; right: number };
type Axes = { rows: readonly string[]; cols: readonly string[] };

export const at = (row: string, col: string): Range => ({ anchor: { row, col }, focus: { row, col } });
/** Where a cell is drawn today, or null when its row or column is not shown (filtered out, removed, not loaded). */
export const indexOf = (cell: Cell, a: Axes) => {
  const r = a.rows.indexOf(cell.row);
  const c = a.cols.indexOf(cell.col);
  return r < 0 || c < 0 ? null : { r, c };
};
/** The range's rectangle in today's order, or null when a corner is not shown. */
export const rectIn = (range: Range | null, a: Axes): Rect | null => {
  const x = range && indexOf(range.anchor, a);
  const y = range && indexOf(range.focus, a);
  if (!x || !y) return null;
  return { top: Math.min(x.r, y.r), bottom: Math.max(x.r, y.r), left: Math.min(x.c, y.c), right: Math.max(x.c, y.c) };
};
/** The row keys a range covers today (what a re-sort or an insert between its corners would change). */
export const spanIn = (range: Range | null, a: Axes) => {
  const x = rectIn(range, a);
  return x ? a.rows.slice(x.top, x.bottom + 1).join("\n") : "";
};
export const rectSize = (x: Rect | null) => (x ? { people: x.bottom - x.top + 1, days: x.right - x.left + 1, cells: (x.bottom - x.top + 1) * (x.right - x.left + 1) } : { people: 0, days: 0, cells: 0 });
export const inRect = (x: Rect | null, r: number, c: number) => !!x && r >= x.top && r <= x.bottom && c >= x.left && c <= x.right;

/** Move or extend a range by a key; null for a key the grid does not own. A focus no longer shown starts at the first cell. */
export function moveRange(range: Range | null, key: string, shift: boolean, a: Axes, page = 10): Range | null {
  if (!a.rows.length || !a.cols.length) return null;
  const f = (range && indexOf(range.focus, a)) ?? { r: 0, c: 0 };
  const to =
    key === "ArrowUp" ? { r: f.r - 1, c: f.c }
    : key === "ArrowDown" ? { r: f.r + 1, c: f.c }
    : key === "ArrowLeft" ? { r: f.r, c: f.c - 1 }
    : key === "ArrowRight" ? { r: f.r, c: f.c + 1 }
    : key === "Home" ? { r: f.r, c: 0 }
    : key === "End" ? { r: f.r, c: a.cols.length - 1 }
    : key === "PageUp" ? { r: f.r - page, c: f.c }
    : key === "PageDown" ? { r: f.r + page, c: f.c }
    : null;
  if (!to) return null;
  const focus = { row: a.rows[Math.max(0, Math.min(a.rows.length - 1, to.r))]!, col: a.cols[Math.max(0, Math.min(a.cols.length - 1, to.c))]! };
  return shift && range && rectIn(range, a) ? { anchor: range.anchor, focus } : { anchor: focus, focus };
}
