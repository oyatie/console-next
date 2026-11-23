import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { isImeKey, leaveImeKey } from "../../lib/pure/ime";
import { at, indexOf, inRect, moveRange, rectIn, spanIn, type Cell, type Range } from "../sheet-grid/range";
import s from "./person-day-grid.module.css";

export type { Cell, Range };
export type DayColumn = { key: string; label: ReactNode; sub: ReactNode; tone?: "holiday" | "rest" };
type SideColumn<R> = { key: string; header: ReactNode; cell: (r: R) => ReactNode; width: "code" | "name" | "total"; hideOnPhone?: boolean };
type CellLook = "draft" | "refused" | "saved" | "locked" | undefined;
export type GridFooterRow = {
  key: string;
  label: ReactNode;
  day: (dayIndex: number) => ReactNode;
  tail: readonly ReactNode[];
};
type CellBadgeTone = "dot" | "annual" | "half" | "holiday" | "overtime" | "unapproved" | "late" | "absent" | "blocking";

/** Compact 1-2 character badge or dot inside a Console month grid cell. */
export function GridCellBadge({ tone, children }: {
  /** Semantic visual tone for the cell badge. */
  tone: CellBadgeTone;
  /** Short 1-2 character badge text or glyph. */
  children: ReactNode;
}) {
  return <bdi className={tone === "dot" ? s.cellDot : s.cellBadge} data-badge={tone}>{children}</bdi>;
}

type Props<R> = {
  label: string;
  /** Rows matching the scope on the server (aria-rowcount), loaded or not. */
  total: number;
  rows: readonly R[];
  rowKey: (r: R) => string;
  lead: readonly SideColumn<R>[];
  days: readonly DayColumn[];
  tail: readonly SideColumn<R>[];
  /** Optional group header spanning all tail columns (2-row thead). */
  tailGroupHeader?: ReactNode;
  /** Active/selected employee row key highlighted with the selected row bar. */
  activeRowId?: string;
  /** Optional summary rows rendered inside tfoot beneath the grid body. */
  footerRows?: readonly GridFooterRow[];
  cell: (r: R, day: number) => ReactNode;
  look: (r: R, day: number) => CellLook;
  /** The cell's text for screen readers (value, marks, draft state). */
  describe: (r: R, day: number) => string;
  /** By row and column key; null (or a corner not shown) selects nothing. */
  range: Range | null;
  /** The new selection. Never a commit: the grid commits the open editor itself before a person moves the selection, and
   * its own collapse (the people under a range changed) leaves the editor and what is being typed alone. */
  onRange: (range: Range) => void;
  /** The open editor and the cell it belongs to: it is drawn only there, whatever has moved since. */
  editing: { value: string; cell: Cell } | null;
  /** Closed: a typed character opens the editor on it, "" (Enter, F2, a double-click) on what the cell holds. Open: its new text; null cancels. */
  onEdit: (value: string | null) => void;
  /** Commit the open editor; the grid then moves `then`. */
  onCommit: (then: "down" | "right" | "stay") => void;
  /** The feature's keys first (⌘D, ⌘↵, =, Delete, P …), also those on a link or a button in a cell; true when handled. */
  onKey: (e: KeyboardEvent) => boolean;
  /** The grid's table, for a caller that must tell the grid itself having the focus from a control in it. */
  tableRef?: RefObject<HTMLTableElement | null>;
  /** A row group's head is drawn above the first row of each group. */
  groupOf?: (r: R) => string;
};

const OVERSCAN = 8;
// The table is the grid: focus, the active descendant and the keys live on it (spread, like ui/table).


/**
 * The person × day grid (spec A3, §12.2): sticky header, sticky employee columns on the left and totals on the right,
 * virtual rows, range selection (Shift+arrows, drag, a name selects the row, a day header the column), type-to-edit
 * with an input that commits on Enter or Tab only outside an IME composition. It owns no data: the feature passes what
 * each cell draws (`cell`), how it looks (`look`) and the keys it handles first (`onKey`). Focus ≠ selection: the
 * focused cell carries the outline, the range the selected fill. `role="grid"` with aria-rowcount and aria-rowindex.
 */
export function PersonDayGrid<R>(p: Props<R>) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  // Virtual rows are placed by the height the CSS gives a row. It is read where the rows are, since a container or a
  // visual style may set the token, and again on resize; 32 is the base value, kept where nothing can be read.
  // The box's height is read with it: before the first scroll nothing else reports it, and a box taller than the
  // 600 assumed above would draw too few rows.
  const [rowHeight, setRowHeight] = useState(32);
  useLayoutEffect(() => {
    const read = () => {
      const height = parseFloat(getComputedStyle(box.current!).getPropertyValue("--row-h-compact"));
      if (height > 0) setRowHeight(height);
      const boxHeight = box.current!.clientHeight;
      if (boxHeight > 0) setScroll((was) => was.height === boxHeight ? was : { ...was, height: boxHeight });
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  const [drag, setDrag] = useState(false);
  const own = useRef<HTMLTableElement>(null), table = p.tableRef ?? own;
  // An editor left by a key gives the focus back to the grid, so the next key lands here; a press has already moved it.
  const held = useRef(false), pressed = useRef(false);
  useEffect(() => {
    if (!p.editing && held.current && !pressed.current) table.current?.focus({ preventScroll: true });
    held.current = pressed.current = false;
  }, [p.editing, table]);
  const axes = { rows: p.rows.map(p.rowKey), cols: p.days.map((d) => d.key) };
  const rect = rectIn(p.range, axes);
  const f = p.range && indexOf(p.range.focus, axes);
  // A selection over several rows is the people between its corners; a re-sort or an insert between them changes who
  // that is, so it collapses to its focus rather than silently cover someone else (a one-row range never changes).
  const span = spanIn(p.range, axes);
  const seen = useRef({ range: p.range, span });
  useLayoutEffect(() => {
    if (p.range && seen.current.range === p.range && seen.current.span !== span && p.range.anchor.row !== p.range.focus.row) p.onRange({ anchor: p.range.focus, focus: p.range.focus });
    seen.current = { range: p.range, span };
  });
  const first = Math.max(0, Math.floor(scroll.top / rowHeight) - OVERSCAN);
  const last = Math.min(p.rows.length, Math.ceil((scroll.top + scroll.height) / rowHeight) + OVERSCAN);
  const cellId = (r: number, c: number) => `${id}-r${r}-c${c}`;
  const focusRow = f?.r;

  useEffect(() => {
    const el = box.current;
    if (!el || focusRow === undefined) return;
    // The sticky head covers the top of the box, so a row is in view between the head's foot and the box's foot.
    const top = focusRow * rowHeight, bottom = top + el.querySelector("thead")!.offsetHeight + rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [focusRow, rowHeight]);
  // Every new range is followed, not only a new column: the box may have been scrolled away by hand since.
  const focusCol = f?.c, editing = !!p.editing, rowPress = useRef(false), leads = p.lead.length, tails = p.tail.length;
  useEffect(() => {
    const el = box.current;
    // A press on a lead selects its row with the focus on the last day: the box stays where the person has it.
    if (!el || focusCol === undefined || rowPress.current) return void (rowPress.current = false);
    // Any drawn body row has one cell per column (a head row may span the totals); the focused one may not be drawn yet.
    const cells = [...el.querySelector("tbody tr:not([aria-hidden])")!.children].map((c) => ({ c, b: c.getBoundingClientRect() }));
    const frame = el.getBoundingClientRect(), day = cells[leads + focusCol]!.b;
    // A lead that scrolls with the days, or is not drawn at this width, covers nothing.
    const sticky = cells.slice(0, leads).filter(({ c, b }) => b.width && getComputedStyle(c).position === "sticky");
    const from = Math.max(frame.left, ...sticky.map(({ b }) => b.right));
    const until = Math.min(frame.left + el.clientWidth, tails ? cells.at(-1)!.b.left : Infinity);
    // Whole pixels: columns can lie on fractions, and the box drops a fraction of a scroll.
    if (day.left < from) el.scrollLeft -= Math.ceil(from - day.left);
    // Never so far that the column's start goes under the lead columns.
    else if (day.right > until) el.scrollLeft += Math.min(Math.ceil(day.right - until), Math.floor(day.left - from));
    // An editor opening is not read above, but it widens its column, which is.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [p.range, focusCol, editing, leads, tails]);
  useEffect(() => {
    const up = () => (setDrag(false), rowPress.current = false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  // A person moves the selection: what they were typing is committed first, where it was typed.
  const select = (next: Range) => (p.editing && (pressed.current = true, p.onCommit("stay")), p.onRange(next));
  const keyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    // A key on a link or a button in a cell is that control's (Enter follows the link), unless the feature takes it.
    if (p.editing || p.onKey(e) || e.target !== e.currentTarget) return;
    const moved = moveRange(p.range, e.key, e.shiftKey, axes);
    if (moved) {
      e.preventDefault();
      p.onRange(moved);
    } else if (!f) {
      return;
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      p.onEdit("");
    } else if (e.key === "Escape") {
      p.onRange({ anchor: p.range!.focus, focus: p.range!.focus });
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      p.onEdit(e.key);
    }
  };
  const pick = (row: string, col: string, extend: boolean) => select(extend && rect ? { anchor: p.range!.anchor, focus: { row, col } } : at(row, col));
  const firstCol = axes.cols[0]!;
  const lastCol = axes.cols.at(-1)!;
  const headerRows = p.tailGroupHeader ? 2 : 1;
  const footerCount = p.footerRows?.length ?? 0;
  const colCount = p.lead.length + p.days.length + p.tail.length;

  return (
    <div ref={box} className={s.box} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
      <table
        ref={table}
        className={s.table}
        {...{
          role: "grid",
          "aria-label": p.label,
          "aria-rowcount": p.total + headerRows + footerCount,
          "aria-colcount": colCount,
          "aria-multiselectable": true,
          "aria-activedescendant": f ? cellId(f.r, f.c) : undefined,
          tabIndex: 0,
          onKeyDown: keyDown,
          // Nothing selected (yet, or its row has left): focus starts on the first cell, by its keys from then on.
          onFocus: () => !f && p.rows.length && p.days.length && p.onRange(at(axes.rows[0]!, axes.cols[0]!)),
        }}
      >
        <thead>
          <tr aria-rowindex={1}>
            {p.lead.map((c) => <th key={c.key} rowSpan={p.tailGroupHeader ? 2 : undefined} className={s.lead} data-w={c.width} data-hide-phone={c.hideOnPhone || undefined}>{c.header}</th>)}
            {p.days.map((d, c) => (
              <th key={d.key} rowSpan={p.tailGroupHeader ? 2 : undefined} className={s.day} data-tone={d.tone} aria-selected={!!rect && c >= rect.left && c <= rect.right} onPointerDown={() => p.rows.length && select({ anchor: { row: axes.rows[0]!, col: d.key }, focus: { row: axes.rows.at(-1)!, col: d.key } })}>
                <span>{d.label}</span>
                <span className={s.sub}>{d.sub}</span>
              </th>
            ))}
            {p.tailGroupHeader ? (
              p.tail.length > 1 ? (
                <>
                  <th colSpan={p.tail.length - 1} className={s.tailGroup}>{p.tailGroupHeader}</th>
                  <th className={s.tailGroupEnd} aria-hidden="true" />
                </>
              ) : (
                <th colSpan={p.tail.length} className={s.tailGroupEnd}>{p.tailGroupHeader}</th>
              )
            ) : (
              p.tail.map((c) => <th key={c.key} className={s.tail} data-w={c.width}>{c.header}</th>)
            )}
          </tr>
          {p.tailGroupHeader && (
            <tr aria-rowindex={2}>
              {p.tail.map((c, ti) => <th key={c.key} className={s.tail} data-w={c.width} data-tail-first={ti === 0 || undefined}>{c.header}</th>)}
            </tr>
          )}
        </thead>
        <tbody>
          {first > 0 && <tr aria-hidden><td aria-hidden colSpan={colCount} height={first * rowHeight} /></tr>}
          {p.rows.slice(first, last).map((row, i) => {
            const r = first + i;
            const key = axes.rows[r]!;
            const group = p.groupOf?.(row);
            const newGroup = group !== undefined && (r === 0 || p.groupOf!(p.rows[r - 1]!) !== group);
            return (
              <tr key={key} aria-rowindex={r + headerRows + 1} className={s.row} data-group={newGroup ? group : undefined} data-active={key === p.activeRowId || undefined}>
                {p.lead.map((c, k) => (
                  <th key={c.key} className={s.lead} data-w={c.width} data-first={k === 0 || undefined} data-hide-phone={c.hideOnPhone || undefined} onPointerDown={() => (rowPress.current = true, select({ anchor: { row: key, col: firstCol }, focus: { row: key, col: lastCol } }))}>{c.cell(row)}</th>
                ))}
                {p.days.map((d, c) => {
                  const focused = !!f && r === f.r && c === f.c;
                  const described = p.describe(row, c);
                  // A press in the open editor's cell is the editor's (the caret, a word): selecting would commit and close it.
                  const open = p.editing?.cell.row === key && p.editing.cell.col === d.key;
                  // A press that ends an edit starts no drag: the closing editor moves other cells under the held pointer.
                  return (
                    <td
                      key={d.key}
                      id={cellId(r, c)}
                      aria-selected={inRect(rect, r, c)}
                      aria-label={described}
                      title={described}
                      className={s.cell}
                      data-tone={d.tone}
                      data-look={p.look(row, c)}
                      data-focus={focused || undefined}
                      onPointerDown={(e) => open || (p.editing || setDrag(true), pick(key, d.key, e.shiftKey))}
                      onMouseDown={(e) => open && e.target === e.currentTarget && e.preventDefault()}
                      onPointerEnter={() => drag && pick(key, d.key, true)}
                      onDoubleClick={() => open || p.onEdit("")}
                    >
                      {open ? <Editor value={p.editing!.value} label={described} onChange={p.onEdit} onCommit={p.onCommit} held={held} /> : p.cell(row, c)}
                    </td>
                  );
                })}
                {p.tail.map((c, ti) => <td key={c.key} className={s.tail} data-w={c.width} data-tail-first={ti === 0 || undefined}>{c.cell(row)}</td>)}
              </tr>
            );
          })}
          {last < p.rows.length && <tr aria-hidden><td aria-hidden colSpan={colCount} height={(p.rows.length - last) * rowHeight} /></tr>}
        </tbody>
        {p.footerRows && p.footerRows.length > 0 && (
          <tfoot>
            {p.footerRows.map((fr, fi) => (
              <tr key={fr.key} aria-rowindex={p.total + headerRows + 1 + fi} className={s.footRow}>
                <th scope="row" colSpan={Math.min(2, p.lead.length)} className={s.footLead}>{fr.label}</th>
                {p.lead.slice(2).map((c) => (
                  <td key={c.key} className={s.footLeadFiller} data-hide-phone={c.hideOnPhone || undefined} aria-hidden="true" />
                ))}
                {p.days.map((d, c) => (
                  <td key={d.key} className={s.footDay} data-tone={d.tone}>{fr.day(c)}</td>
                ))}
                {p.tail.map((c, ti) => (
                  <td key={c.key} className={s.footTail} data-tail-first={ti === 0 || undefined} data-sticky={ti === p.tail.length - 1 || undefined}>{fr.tail[ti] ?? null}</td>
                ))}
              </tr>
            ))}
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** The in-cell input: Enter commits and moves down, Tab right, Esc cancels; an IME composition is never cut. */
function Editor({ value, label, onChange, onCommit, held }: { value: string; label: string; onChange: (v: string | null) => void; onCommit: (then: "down" | "right" | "stay") => void; held: RefObject<boolean> }) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = input.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    // Read as it leaves, while still in the page; moving the focus off a live input would blur it, a second commit.
    return () => { held.current = document.activeElement === el; };
  }, [held]);
  return (
    <input
      ref={input}
      className={s.editor}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      // A composing Escape or Tab is the input method's; the Tab's own move is cancelled too, so the focus stays here.
      onKeyDownCapture={(e) => (leaveImeKey(e), e.key === "Tab" && isImeKey(e) && e.preventDefault())}
      onKeyDown={(e) => {
        if (isImeKey(e)) return;
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit("down");
        } else if (e.key === "Tab") {
          e.preventDefault();
          onCommit("right");
        } else if (e.key === "Escape") onChange(null);
      }}
      onBlur={() => onCommit("stay")}
    />
  );
}
