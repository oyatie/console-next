// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { TextInput } from "../field/field";
import { narrow } from "./choices";
import { at as rangeAt, indexOf, inRect, moveRange, rectIn, type Range } from "./range";
import { gridViewport, useGridWindow } from "./use-grid-window";
import s from "./sheet-grid.module.css";
import k from "./input.module.css";
import m from "./window.module.css";

const DEFAULT_VISIBLE = 25;
const DEFAULT_OVERSCAN = 10;

type At = { r: number; c: number };
type SheetGridCell = {
  label: string;
  value: string;
  previous?: ReactNode;
  changed?: boolean;
  invalid?: boolean;
  error?: ReactNode;
  suggestion?: { value: string; content: ReactNode };
};
export type SheetGridColumn<R> = {
  key: string;
  header: ReactNode;
  meta?: ReactNode;
  metaTone?: "warn" | "info";
  options?: readonly string[];
  cell: (row: R, rowIndex: number) => SheetGridCell;
};
type SheetGridLeadingColumn<R> = { key: string; header: ReactNode; cell: (row: R) => ReactNode; className?: string };
type SheetGridTailColumn<R> = {
  header: ReactNode;
  cell: (row: R) => { tone: "changed" | "error" | "same"; content: ReactNode };
};

const id = (r: number, c: number) => `grid-${r}-${c}`;
const same = (a: At | null, r: number, c: number) => a?.r === r && a.c === c;
const choiceWords = <R,>(f: SheetGridColumn<R>) => f.options ?? [];
const pickable = <R,>(f: SheetGridColumn<R>, text: string) => narrow(choiceWords(f), text);
/**
 * An editable, windowed data grid. It owns keyboard focus, rectangular selection and IME-safe editing; callers own
 * values, validation, labels and the eventual command. The focused cell keeps an input mounted even outside edit mode
 * so a printable key or an IME composition cannot lose its first character.
 */
export function SheetGrid<R>({
  rows, rowKey, columns, leading, tail, rowHeader, label, onCell, parsePaste, activeCell, onActiveChange,
  visibleRows = DEFAULT_VISIBLE, overscan = DEFAULT_OVERSCAN,
}: {
  rows: readonly R[];
  rowKey: (row: R) => string;
  columns: readonly SheetGridColumn<R>[];
  leading: readonly SheetGridLeadingColumn<R>[];
  tail: SheetGridTailColumn<R>;
  rowHeader: ReactNode;
  label: string;
  onCell: (row: R, col: number, text: string) => void;
  parsePaste: (text: string) => readonly (readonly string[])[];
  activeCell?: At | null;
  onActiveChange?: (at: At | null) => void;
  visibleRows?: number;
  overscan?: number;
}) {
  const [uncontrolledActive, setUncontrolledActive] = useState<At | null>(null);
  const active = activeCell !== undefined ? activeCell : uncontrolledActive;
  const setActive = (next: At | null) => {
    setUncontrolledActive(next);
    onActiveChange?.(next);
  };
  const [editing, setEditing] = useState<At | null>(null);
  const [typed, setTyped] = useState("");
  const [opt, setOpt] = useState(0);
  const [range, setRange] = useState<Range | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const focusPending = useRef(false), parkingFocus = useRef(false);
  // A blur during a move runs before re-render; handlers must read the edited cell synchronously.
  const editingNow = useRef<At | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const enterAfterIme = useRef(false);
  const axes = { rows: rows.map(rowKey), cols: columns.map((column) => column.key) };
  const startEditing = (r: number, c: number) => ((editingNow.current = { r, c }), setEditing({ r, c }));
  const shown = (row: R, r: number, c: number) => columns[c]!.cell(row, r).value;
  const validActive = Boolean(active && rows[active.r] && columns[active.c]);
  const storedFocus = range && indexOf(range.focus, axes);
  const selection = active && validActive && (storedFocus?.r !== active.r || storedFocus.c !== active.c)
    ? rangeAt(rowKey(rows[active.r]!), columns[active.c]!.key) : range;
  const rect = rectIn(selection, axes);
  const move = (r: number, c: number) => {
    if (!rows.length || !columns.length) return;
    setActive({ r: Math.max(0, Math.min(rows.length - 1, r)), c: Math.max(0, Math.min(columns.length - 1, c)) });
  };
  const nextError = (r: number, c: number) => {
    const flat = rows.flatMap((row, ri) => columns.map((column, ci) => ({ ri, ci, bad: column.cell(row, ri).invalid })));
    const next = flat.find((cell) => cell.bad && (cell.ri > r || (cell.ri === r && cell.ci > c))) ?? flat.find((cell) => cell.bad);
    if (next) move(next.ri, next.ci);
  };
  const fillDown = () => {
    const box = rectIn(selection, axes);
    const focus = selection && indexOf(selection.focus, axes);
    if (!box || !focus) return;
    const value = shown(rows[box.top]!, box.top, focus.c);
    for (let r = box.top + 1; r <= box.bottom; r++) onCell(rows[r]!, focus.c, value);
  };
  const begin = (r: number, c: number, text: string) => {
    const el = input.current;
    if (el) {
      el.value = text;
      el.setSelectionRange(text.length, text.length);
    }
    setTyped(text);
    setOpt(Math.max(0, choiceWords(columns[c]!).indexOf(shown(rows[r]!, r, c))));
    startEditing(r, c);
  };
  const leave = (commit: boolean, to?: At, choice?: string) => {
    const el = input.current;
    const was = editingNow.current;
    editingNow.current = null;
    enterAfterIme.current = false;
    if (was && el) {
      const options = pickable(columns[was.c]!, el.value);
      if (commit) onCell(rows[was.r]!, was.c, choice ?? (options.length ? options[Math.min(opt, options.length - 1)]! : el.value));
      el.value = "";
    }
    setEditing(null);
    setTyped("");
    if (to) move(to.r, to.c);
  };
  const { first, last, rowHeight, viewportRows, setScrollTop } = useGridWindow(gridRef, rows.length, visibleRows, overscan, (top, bottom) => {
    if (input.current && document.activeElement === input.current) {
      const bounds = input.current.getBoundingClientRect();
      if (bounds.bottom <= top || bounds.top >= bottom) {
        leave(true);
        parkingFocus.current = true;
        gridRef.current!.focus({ preventScroll: true });
        parkingFocus.current = false;
      }
    }
  });

  const mounted = validActive && active!.r >= first && active!.r < last;
  useLayoutEffect(() => {
    if (!active || !validActive) return;
    focusPending.current = true;
    if (gridRef.current) {
      const { scroller, top, bottom, rowsTop } = gridViewport(gridRef.current);
      const cellTop = rowsTop + active.r * rowHeight;
      const delta = cellTop < top ? cellTop - top : Math.max(0, cellTop + rowHeight - bottom);
      scroller.scrollBy({ top: delta, behavior: "instant" });
      setScrollTop(Math.max(0, top - rowsTop + delta));
    }
  }, [active, validActive, rowHeight, setScrollTop, gridRef]);
  // Scrolling may need a second render to mount the requested cell's input.
  useLayoutEffect(() => {
    if (focusPending.current && input.current) {
      input.current.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      input.current.focus({ preventScroll: true });
      focusPending.current = false;
    }
  });

  const nav = (e: KeyboardEvent<HTMLElement>, r: number, c: number) => {
    if (!rows[r] || !columns[c]) return;
    const selected = selection && indexOf(selection.focus, axes);
    const current = selected?.r === r && selected.c === c ? selection! : rangeAt(rowKey(rows[r]!), columns[c]!.key);
    const moved = moveRange(current, e.key, e.shiftKey, axes, Math.max(1, viewportRows - 1), e.ctrlKey || e.metaKey);
    if (moved) {
      e.preventDefault();
      setRange(moved);
      const focus = indexOf(moved.focus, axes)!;
      return move(focus.r, focus.c);
    }
    if (e.key === "F8") return (e.preventDefault(), nextError(r, c));
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") return (e.preventDefault(), fillDown());
    const cell = columns[c]!.cell(rows[r]!, r);
    if (e.key === "Enter" && cell.suggestion) return (e.preventDefault(), onCell(rows[r]!, c, cell.suggestion.value));
    if (e.key === "F2" || e.key === "Enter") return (e.preventDefault(), begin(r, c, columns[c]!.options?.length ? "" : cell.value));
    if (e.key === "Delete" || e.key === "Backspace") return (e.preventDefault(), onCell(rows[r]!, c, ""));
    // Anything else (a printable key, an IME's 「Process」) goes into the mounted input and starts editing on input.
  };
  const edit = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    // A key that ends an IME composition belongs to the composition; an Enter there applies once it has ended.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return void (e.key === "Enter" && (enterAfterIme.current = true));
    const options = pickable(columns[c]!, e.currentTarget.value);
    if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      return setOpt((o) => (Math.min(o, options.length - 1) + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    }
    if (e.key === "Enter" || e.key === "Tab") return (e.preventDefault(), leave(true, { r: e.key === "Enter" ? r + 1 : r, c: e.key === "Tab" ? c + 1 : c }));
    if (e.key === "Escape") return (e.preventDefault(), leave(false));
  };
  const paste = (e: ClipboardEvent, r: number, c: number) => {
    if (editing) return;
    const block = parsePaste(e.clipboardData.getData("text/plain"));
    if (!block.length) return;
    e.preventDefault();
    block.forEach((line, dr) => line.forEach((v, dc) => {
      const row = rows[r + dr];
      if (row && c + dc < columns.length && v.trim() !== "") onCell(row, c + dc, v);
    }));
  };
  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    const curr = active ?? { r: 0, c: 0 };
    nav(e, curr.r, curr.c);
  };

  const activeView = active && rows[active.r] && columns[active.c]?.cell(rows[active.r]!, active.r);
  const editableStart = leading.length + 2;
  const colCount = leading.length + columns.length + 2;
  return (
    <div ref={(element) => {
      gridRef.current = element;
      element?.style.setProperty("--sheet-cols", String(columns.length));
      element?.style.setProperty("--sheet-lead-cols", String(leading.length));
    }} className={`${s.grid} ${m.grid}`} role="grid" tabIndex={mounted ? -1 : 0} onKeyDown={onGridKeyDown}
      onFocus={(e) => e.target === e.currentTarget && !parkingFocus.current && !mounted && move(active?.r ?? 0, active?.c ?? 0)}
      aria-label={label} aria-rowcount={rows.length + 1} aria-colcount={colCount} aria-multiselectable>
      <div role="row" aria-rowindex={1} className={s.head}>
        <span role="columnheader" aria-colindex={1} className={s.n}>{rowHeader}</span>
        {leading.map((column, c) => <span key={column.key} role="columnheader" aria-colindex={c + 2}>{column.header}</span>)}
        {columns.map((column, c) => <span key={column.key} role="columnheader" aria-colindex={editableStart + c} className={s.colHead}>{column.header}{column.meta && <span className={s.tag} data-tone={column.metaTone}>{column.meta}</span>}</span>)}
        <span role="columnheader" aria-colindex={colCount}>{tail.header}</span>
      </div>
      {first > 0 && <svg height={first * rowHeight} className={m.spacer} aria-hidden />}
      {rows.slice(first, last).map((row, idx) => {
        const r = first + idx;
        const st = tail.cell(row);
        return (
          <div key={rowKey(row)} role="row" aria-rowindex={r + 2} className={`${s.row} ${m.row}`}>
            <span role="rowheader" aria-colindex={1} className={s.n}>{r + 1}</span>
            {leading.map((column, c) => <span key={column.key} role="gridcell" aria-colindex={c + 2} className={column.className}>{column.cell(row)}</span>)}
            {columns.map((f, c) => {
              const cell = f.cell(row, r);
              const changed = cell.changed;
              const bad = cell.invalid;
              const cellName = cell.label;
              const isEditing = same(editing, r, c);
              const options = isEditing ? pickable(f, typed) : [];
              const listId = `${id(r, c)}-options`;
              return (
                <span
                  key={f.key} id={id(r, c)} role="gridcell" aria-colindex={editableStart + c} aria-selected={inRect(rect, r, c)} tabIndex={-1}
                  aria-label={cellName} aria-invalid={bad || undefined} className={`${s.cell} ${k.cell}`}
                  data-changed={changed || undefined} data-bad={bad || undefined} data-editing={isEditing || undefined}
                  onPaste={(e) => paste(e, r, c)}
                  onFocus={(e) => e.target === e.currentTarget && (same(active, r, c) ? input.current?.focus() : setActive({ r, c }))}
                  onDoubleClick={() => (same(active, r, c) ? begin(r, c, cell.value) : undefined)}
                  onPointerDown={(e) => {
                    const next = rangeAt(rowKey(row), f.key);
                    setRange(e.shiftKey && selection && rect ? { anchor: selection.anchor, focus: next.focus } : next);
                    if (!same(active, r, c)) setActive({ r, c });
                  }}
                >
                  {!isEditing && changed && <s className={s.old}>{cell.previous}</s>}
                  {!isEditing && <span className={changed ? s.new : undefined}>{cell.value}</span>}
                  {same(active, r, c) && (
                    <TextInput
                      ref={input} aria-label={cellName} className={isEditing ? k.edit : k.catch} autoComplete="off"
                      role={choiceWords(f).length ? "combobox" : undefined} aria-expanded={choiceWords(f).length ? isEditing : undefined}
                      aria-controls={options.length ? listId : undefined} aria-activedescendant={options.length ? `${listId}-${Math.min(opt, options.length - 1)}` : undefined}
                      onInput={(e) => (setTyped(e.currentTarget.value), setOpt(0), editingNow.current || startEditing(r, c))}
                      onCompositionStart={() => editingNow.current || startEditing(r, c)}
                      onCompositionEnd={() => enterAfterIme.current && leave(true, { r: r + 1, c })}
                      onKeyDown={(e) => (editingNow.current ? edit(e, r, c) : nav(e, r, c))}
                      onBlur={() => editingNow.current && leave(true)}
                    />
                  )}
                  {options.length > 0 && (
                    <span id={listId} role="listbox" aria-label={cellName}>
                      {options.map((o, i) => {
                        const on = i === Math.min(opt, options.length - 1);
                        return <span key={o} id={`${listId}-${i}`} role="option" aria-selected={on} className={on ? undefined : "sr-only"}>{on ? <b>{o}</b> : o}</span>;
                      })}
                      {options.length > 1 && <span className="muted num" aria-hidden> {Math.min(opt, options.length - 1) + 1}/{options.length}</span>}
                    </span>
                  )}
                </span>
              );
            })}
            <span role="gridcell" aria-colindex={colCount} className={s.status} data-tone={st.tone}>{st.tone === "error" && <AlertTriangle size={12} aria-hidden />}{st.content}</span>
          </div>
        );
      })}
      {last < rows.length && <svg height={(rows.length - last) * rowHeight} className={m.spacer} aria-hidden />}
      {activeView?.invalid && activeView.error && (
        <div className={s.tip} role="status">
          <AlertTriangle size={14} aria-hidden />
          <b>{activeView.error}</b>
          {activeView.suggestion && <span>{activeView.suggestion.content}</span>}
        </div>
      )}
    </div>
  );
}
