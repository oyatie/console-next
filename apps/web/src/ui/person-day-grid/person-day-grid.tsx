import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { isImeKey } from "../../lib/pure/ime";
import { at, indexOf, inRect, moveRange, rectIn, spanIn, type Cell, type Range } from "../sheet-grid/range";
import s from "./person-day-grid.module.css";

export type { Cell, Range };
export type DayColumn = { key: string; label: ReactNode; sub: ReactNode; tone?: "holiday" | "rest" };
type SideColumn<R> = { key: string; header: ReactNode; cell: (r: R) => ReactNode; width: "code" | "name" | "total" };
type CellLook = "draft" | "refused" | "saved" | "locked" | undefined;

type Props<R> = {
  label: string;
  /** Rows matching the scope on the server (aria-rowcount), loaded or not. */
  total: number;
  rows: readonly R[];
  rowKey: (r: R) => string;
  lead: readonly SideColumn<R>[];
  days: readonly DayColumn[];
  tail: readonly SideColumn<R>[];
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
  /** With no editor open: a typed character starts an edit on that character, and "" (Enter, F2, a double-click) asks
   * for one on what the cell holds, which only the caller knows. With one open: its new text. null closes it unsaved. */
  onEdit: (value: string | null) => void;
  /** Commit the open editor; the grid then moves `then`. */
  onCommit: (then: "down" | "right" | "stay") => void;
  /** The feature's keys first (⌘D, ⌘↵, =, Delete, P …); true when handled. */
  onKey: (e: KeyboardEvent) => boolean;
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
  const leads = p.lead.length, tails = p.tail.length;
  // After every render, since the rows drawn decide how wide the columns are, and whenever the box or the table
  // changes size without one (a font arriving, a window or a docked sheet resizing).
  useLayoutEffect(() => placeSides(box.current!, leads, tails));
  useLayoutEffect(() => {
    const el = box.current!, watch = new ResizeObserver(() => placeSides(el, leads, tails));
    watch.observe(el);
    watch.observe(el.firstElementChild!);
    return () => watch.disconnect();
  }, [leads, tails]);
  const [drag, setDrag] = useState(false);
  const table = useRef<HTMLTableElement>(null);
  // The editor left while it held the focus (Enter, Tab, Escape): the grid takes the focus back, so the next key lands
  // here. One left by a press outside the grid had already given the focus away, and a press on the grid gives the
  // grid the focus by itself, as a press does: without the focus ring a key brings.
  const held = useRef(false), pressed = useRef(false);
  useEffect(() => {
    if (!p.editing && held.current && !pressed.current) table.current?.focus({ preventScroll: true });
    held.current = pressed.current = false;
  }, [p.editing]);
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
  // Sideways the sticky lead columns cover the left of the box and the held totals the right: a column is in view
  // between them. It is read from the head row, which is always drawn.
  const focusCol = f?.c, editing = !!p.editing;
  useEffect(() => {
    const el = box.current;
    if (!el || focusCol === undefined) return;
    const head = [...el.querySelector("thead tr")!.children].map((c) => c.getBoundingClientRect()), frame = el.getBoundingClientRect();
    const day = head[leads + focusCol]!, from = head[leads - 1]?.right ?? frame.left;
    const until = Math.min(frame.left + el.clientWidth, ...head.slice(head.length - tails).map((c) => c.left));
    if (day.left < from) el.scrollLeft -= from - day.left;
    // Never so far that the column's start goes under the lead columns.
    else if (day.right > until) el.scrollLeft += Math.min(day.right - until, day.left - from);
    // An editor opening is not read above, but it widens its column, which is.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [focusCol, editing, leads, tails]);
  useEffect(() => {
    const up = () => setDrag(false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  // A person moves the selection: what they were typing is committed first, where it was typed.
  const select = (next: Range) => (p.editing && (pressed.current = true, p.onCommit("stay")), p.onRange(next));
  const keyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    // The grid's keys are the ones pressed on the grid itself. A key on a link or a button inside a cell is that
    // control's: Enter follows the link.
    if (e.target !== e.currentTarget || p.editing || p.onKey(e)) return;
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

  return (
    <div ref={box} className={s.box} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
      <table
        ref={table}
        className={s.table}
        {...{
          role: "grid",
          "aria-label": p.label,
          "aria-rowcount": p.total + 1,
          "aria-colcount": p.lead.length + p.days.length + p.tail.length,
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
            {p.lead.map((c) => <th key={c.key} className={s.lead} data-w={c.width}>{c.header}</th>)}
            {p.days.map((d, c) => (
              <th key={d.key} className={s.day} data-tone={d.tone} aria-selected={!!rect && c >= rect.left && c <= rect.right} onPointerDown={() => p.rows.length && select({ anchor: { row: axes.rows[0]!, col: d.key }, focus: { row: axes.rows.at(-1)!, col: d.key } })}>
                <span>{d.label}</span>
                <span className={s.sub}>{d.sub}</span>
              </th>
            ))}
            {p.tail.map((c) => <th key={c.key} className={s.tail} data-w={c.width}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {first > 0 && <tr aria-hidden><td aria-hidden colSpan={p.lead.length + p.days.length + p.tail.length} height={first * rowHeight} /></tr>}
          {p.rows.slice(first, last).map((row, i) => {
            const r = first + i;
            const key = axes.rows[r]!;
            const group = p.groupOf?.(row);
            const newGroup = group !== undefined && (r === 0 || p.groupOf!(p.rows[r - 1]!) !== group);
            return (
              <tr key={key} aria-rowindex={r + 2} className={s.row} data-group={newGroup ? group : undefined}>
                {p.lead.map((c, k) => (
                  <th key={c.key} className={s.lead} data-w={c.width} data-first={k === 0 || undefined} onPointerDown={() => select({ anchor: { row: key, col: firstCol }, focus: { row: key, col: lastCol } })}>{c.cell(row)}</th>
                ))}
                {p.days.map((d, c) => {
                  const focused = !!f && r === f.r && c === f.c;
                  // A press or a double-click in the cell that holds the open editor is the editor's own (the caret,
                  // a word): the cell neither selects, which would commit and close it, nor opens it again.
                  const open = p.editing?.cell.row === key && p.editing.cell.col === d.key;
                  return (
                    <td
                      key={d.key}
                      id={cellId(r, c)}
                     
                      aria-selected={inRect(rect, r, c)}
                      aria-label={p.describe(row, c)}
                      className={s.cell}
                      data-tone={d.tone}
                      data-look={p.look(row, c)}
                      data-focus={focused || undefined}
                      onPointerDown={(e) => open || (setDrag(true), pick(key, d.key, e.shiftKey))}
                      onPointerEnter={() => drag && pick(key, d.key, true)}
                      onDoubleClick={() => open || p.onEdit("")}
                    >
                      {open ? <Editor value={p.editing!.value} label={p.describe(row, c)} onChange={p.onEdit} onCommit={p.onCommit} held={held} /> : p.cell(row, c)}
                    </td>
                  );
                })}
                {p.tail.map((c) => <td key={c.key} className={s.tail} data-w={c.width}>{c.cell(row)}</td>)}
              </tr>
            );
          })}
          {last < p.rows.length && <tr aria-hidden><td aria-hidden colSpan={p.lead.length + p.days.length + p.tail.length} height={(p.rows.length - last) * rowHeight} /></tr>}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Sticky side columns stand side by side: each is held past the ones outside it, at an offset measured from the head
 * row (a column is as wide as what it holds) and set on the box for the styles. The lead columns are always held. The
 * totals are held from the outside in while a week of days stays in view between the two sides; in a narrower box the
 * inner ones, then all of them, scroll with the days.
 */
function placeSides(box: HTMLElement, leads: number, tails: number) {
  const widths = [...box.querySelector("thead tr")!.children].map((c) => c.getBoundingClientRect().width);
  const set = (name: string, value: string) => box.style.getPropertyValue(name) === value || box.style.setProperty(name, value);
  let left = 0, right = 0;
  widths.slice(0, leads).forEach((w, k) => {
    if (k) set(`--lead-${k}`, `${left}px`);
    left += w;
  });
  // A day is as wide as the narrowest one: an open editor or a long draft widens its own column only.
  let room = box.clientWidth - left - 7 * Math.min(...widths.slice(leads, widths.length - tails));
  widths.slice(widths.length - tails).reverse().forEach((w, k) => {
    // Once one does not fit, none inside it is held.
    room = room >= w ? room - w : -Infinity;
    set(`--tail-${k}`, room >= 0 ? `${right}px` : "auto");
    right += w;
  });
}

/** The in-cell input: Enter commits and moves down, Tab right, Esc cancels; an IME composition is never cut. */
function Editor({ value, label, onChange, onCommit, held }: { value: string; label: string; onChange: (v: string | null) => void; onCommit: (then: "down" | "right" | "stay") => void; held: RefObject<boolean> }) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = input.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    // Whether it held the focus is read as it leaves, while it is still in the page; the grid acts on it once it is
    // gone (moving the focus off a live input would be its blur, a second commit).
    return () => { held.current = document.activeElement === el; };
  }, [held]);
  return (
    <input
      ref={input}
      className={s.editor}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
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
