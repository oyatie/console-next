import { useEffectEvent, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { t } from "@console/i18n";
import { parseTsv, TYPES, type Cell, type GridField } from "../domain/grid";
import { TextInput } from "../../../ui/field/field";
import { refusedText } from "../present";
import { label as enumLabel } from "../../../lib/labels";
import { narrow } from "../domain/grid-choices";
import s from "./grid.module.css";
import k from "./grid-input.module.css";
import m from "./grid-table.module.css";

const DEFAULT_VISIBLE = 25;
const DEFAULT_OVERSCAN = 10;

export type GridRow = { id: string; number: string; name: string; current: readonly string[]; typed: readonly (string | undefined)[]; cells: readonly Cell[] };
type Range = { col: number; from: number; to: number } | null;
type At = { r: number; c: number };

const id = (r: number, c: number) => `grid-${r}-${c}`;
const same = (a: At | null, r: number, c: number) => a?.r === r && a.c === c;
const TYPE = { type: "employmentType", values: TYPES };
const choiceWords = (f: GridField): readonly string[] =>
  f.kind === "sex" ? [t("bulkGrid.sex.MALE"), t("bulkGrid.sex.FEMALE")] : f.kind === "type" ? TYPES.map((v) => enumLabel(TYPE, v)) : [];
const pickable = (f: GridField, text: string) => narrow(choiceWords(f), text);

const viewport = (grid: HTMLDivElement) => {
  let scroller: HTMLElement | null = grid.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  const padding = getComputedStyle(scroller ?? document.documentElement);
  const top = (scroller ? Math.max(0, scroller.getBoundingClientRect().top + scroller.clientTop) : 0) + (parseFloat(padding.scrollPaddingTop) || 0);
  const bottom = (scroller ? Math.min(window.innerHeight, scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight) : window.innerHeight) - (parseFloat(padding.scrollPaddingBottom) || 0);
  const rowsTop = grid.getBoundingClientRect().top + grid.clientTop + (grid.firstElementChild?.firstElementChild?.getBoundingClientRect().height ?? 0);
  return { scroller: scroller ?? window, top, bottom: bottom - (grid.querySelector<HTMLElement>(':scope > [role="status"]')?.offsetHeight ?? 0), rowsTop };
};

const nextCell = (key: string, r: number, c: number, rc: number, cc: number, ctrl?: boolean, page = DEFAULT_VISIBLE): At =>
  key === "ArrowDown" ? { r: Math.min(rc - 1, r + 1), c }
  : key === "ArrowUp" ? { r: Math.max(0, r - 1), c }
  : key === "ArrowLeft" ? { r, c: Math.max(0, c - 1) }
  : key === "ArrowRight" ? { r, c: Math.min(cc - 1, c + 1) }
  : key === "PageDown" ? { r: Math.min(rc - 1, r + page), c }
  : key === "PageUp" ? { r: Math.max(0, r - page), c }
  : key === "Home" ? (ctrl ? { r: 0, c: 0 } : { r, c: 0 })
  : key === "End" ? (ctrl ? { r: rc - 1, c: cc - 1 } : { r, c: cc - 1 }) : { r, c };

/**
 * The correction grid (spec E6-grid, APG grid keys): arrows move, typing or F2 edits, Enter/Esc leave the cell,
 * Shift+↓ selects down a column and Ctrl+D fills it from its top cell, ⌘V pastes a spreadsheet block from the focused
 * cell (a blank keeps, ∅ clears), F8 goes to the next error. A changed cell shows the old value struck before the new
 * one; an error says why under it, with a near value Enter takes.
 *
 * r3:records-01: the focused cell holds one input from the moment it is focused, so typing (a Korean IME's composition
 * included) lands in it before anything re-renders: no character is lost and the value committed is the one shown.
 * r3:records-17: sex and employment type edit through their options (↑↓ and Enter, or type to narrow).
 */
export function GridTable({
  rows, columns, label, onCell, statusOf, fieldLabel, suggestionOf, activeCell, onActiveChange,
  visibleRows = DEFAULT_VISIBLE, overscan = DEFAULT_OVERSCAN,
}: {
  rows: readonly GridRow[];
  columns: readonly GridField[];
  label: string;
  onCell: (rowId: string, col: number, text: string) => void;
  statusOf: (r: GridRow) => { tone: "changed" | "error" | "same"; text: string };
  fieldLabel: (f: GridField) => string;
  suggestionOf: (c: Cell) => string | undefined;
  activeCell?: At | null;
  onActiveChange?: (at: At | null) => void;
  visibleRows?: number; overscan?: number;
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
  const [range, setRange] = useState<Range>(null);
  const input = useRef<HTMLInputElement>(null);
  const focusPending = useRef(false), parkingFocus = useRef(false);
  // A blur during a move runs before re-render; handlers must read the edited cell synchronously.
  const editingNow = useRef<At | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(1), [scrollTop, setScrollTop] = useState(0);
  const [viewportRows, setViewportRows] = useState(visibleRows);

  const windowSize = viewportRows + overscan;
  const first = Math.max(0, Math.min(rows.length - windowSize, Math.floor(scrollTop / rowHeight) - Math.floor(overscan / 2)));
  const last = Math.min(rows.length, first + windowSize);

  const enterAfterIme = useRef(false);
  const startEditing = (r: number, c: number) => ((editingNow.current = { r, c }), setEditing({ r, c }));
  const shown = (row: GridRow, c: number) => row.typed[c] ?? row.current[c] ?? "";
  const inRange = (r: number, c: number) => range && range.col === c && r >= Math.min(range.from, range.to) && r <= Math.max(range.from, range.to);
  const validActive = Boolean(active && rows[active.r]?.cells[active.c] && columns[active.c]);
  const mounted = validActive && active!.r >= first && active!.r < last;
  useLayoutEffect(() => {
    if (!active || !validActive) return;
    focusPending.current = true;
    if (gridRef.current) {
      const { scroller, top, bottom, rowsTop } = viewport(gridRef.current);
      const cellTop = rowsTop + active.r * rowHeight;
      const delta = cellTop < top ? cellTop - top : Math.max(0, cellTop + rowHeight - bottom);
      scroller.scrollBy({ top: delta, behavior: "instant" });
      setScrollTop(Math.max(0, top - rowsTop + delta));
    }
  }, [active, validActive, rowHeight]);
  // Scrolling may need a second render to mount the requested cell's input.
  useLayoutEffect(() => {
    if (focusPending.current && input.current) {
      input.current.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      input.current.focus({ preventScroll: true });
      focusPending.current = false;
    }
  });

  const move = (r: number, c: number) => {
    if (!rows.length || !columns.length) return;
    setActive({ r: Math.max(0, Math.min(rows.length - 1, r)), c: Math.max(0, Math.min(columns.length - 1, c)) });
  };
  const nextError = (r: number, c: number) => {
    const flat = rows.flatMap((row, ri) => row.cells.map((cell, ci) => ({ ri, ci, bad: "bad" in cell })));
    const after = flat.find((x) => x.bad && (x.ri > r || (x.ri === r && x.ci > c))) ?? flat.find((x) => x.bad);
    if (after) move(after.ri, after.ci);
  };
  const fillDown = () => {
    if (!range) return;
    const [a, b] = [Math.min(range.from, range.to), Math.max(range.from, range.to)];
    const top = shown(rows[a]!, range.col);
    for (let r = a + 1; r <= b; r++) onCell(rows[r]!.id, range.col, top);
  };
  const begin = (r: number, c: number, text: string) => {
    const el = input.current;
    if (el) {
      el.value = text;
      el.setSelectionRange(text.length, text.length);
    }
    setTyped(text);
    setOpt(Math.max(0, choiceWords(columns[c]!).indexOf(shown(rows[r]!, c))));
    startEditing(r, c);
  };
  const leave = (commit: boolean, to?: At, choice?: string) => {
    const el = input.current;
    const was = editingNow.current;
    editingNow.current = null;
    enterAfterIme.current = false;
    if (was && el) {
      const options = pickable(columns[was.c]!, el.value);
      if (commit) onCell(rows[was.r]!.id, was.c, choice ?? (options.length ? options[Math.min(opt, options.length - 1)]! : el.value));
      el.value = "";
    }
    setEditing(null);
    setTyped("");
    if (to) move(to.r, to.c);
  };
  const onScroll = useEffectEvent((minimum: number, count: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const height = parseFloat(getComputedStyle(grid).getPropertyValue("--row-h"));
    const { top, bottom, rowsTop } = viewport(grid);
    if (input.current && document.activeElement === input.current) {
      const bounds = input.current.getBoundingClientRect();
      if (bounds.bottom <= top || bounds.top >= bottom) {
        leave(true);
        parkingFocus.current = true;
        grid.focus({ preventScroll: true });
        parkingFocus.current = false;
      }
    }
    setRowHeight(height);
    setScrollTop(Math.max(0, Math.min(count * height, top - rowsTop)));
    setViewportRows(Math.max(minimum, Math.ceil((bottom - top) / height) + 1));
  });
  useLayoutEffect(() => {
    const update = () => onScroll(visibleRows, rows.length);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(gridRef.current!.firstElementChild!.firstElementChild!);
    observer.observe(gridRef.current!.parentElement!);
    // Scroll does not bubble; capture also observes the document and any scrollable ancestor.
    window.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [visibleRows, rows.length]);

  const nav = (e: KeyboardEvent<HTMLElement>, r: number, c: number) => {
    if (!rows[r]?.cells[c] || !columns[c]) return;
    const key = e.key;
    if (key === "ArrowDown" && e.shiftKey) {
      e.preventDefault();
      setRange((x) => ({ col: c, from: x?.col === c ? x.from : r, to: Math.min(rows.length - 1, r + 1) }));
      return move(r + 1, c);
    }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"].includes(key)) {
      e.preventDefault();
      setRange(null);
      const next = nextCell(key, r, c, rows.length, columns.length, e.ctrlKey || e.metaKey, Math.max(1, viewportRows - 1));
      return move(next.r, next.c);
    }
    if (key === "F8") return (e.preventDefault(), nextError(r, c));
    if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "d") return (e.preventDefault(), fillDown());
    const sug = suggestionOf(rows[r]!.cells[c]!);
    if (key === "Enter" && sug) return (e.preventDefault(), onCell(rows[r]!.id, c, sug));
    if (key === "F2" || key === "Enter") return (e.preventDefault(), begin(r, c, choiceWords(columns[c]!).length ? "" : shown(rows[r]!, c)));
    if (key === "Delete" || key === "Backspace") return (e.preventDefault(), onCell(rows[r]!.id, c, ""));
    // Anything else (a printable key, an IME's 「Process」) goes into the input as typed: its input event starts editing.
  };
  // Keys while editing: Enter and Tab keep the value and move, Esc drops it; ↑↓ walk the options of a choice column.
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
    const block = parseTsv(e.clipboardData.getData("text/plain"));
    if (!block.length) return;
    e.preventDefault();
    block.forEach((line, dr) => line.forEach((v, dc) => {
      const row = rows[r + dr];
      // A blank pasted cell keeps the value (spec E6); only cells inside the grid are written.
      if (row && c + dc < columns.length && v.trim() !== "") onCell(row.id, c + dc, v);
    }));
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    const curr = active ?? { r: 0, c: 0 };
    nav(e, curr.r, curr.c);
  };

  const at = active && rows[active.r]?.cells[active.c];
  return (
    <div ref={gridRef} className={`${s.grid} ${m.grid}`} role="grid" tabIndex={mounted ? -1 : 0} onKeyDown={onGridKeyDown}
      onFocus={(e) => e.target === e.currentTarget && !parkingFocus.current && !mounted && move(active?.r ?? 0, active?.c ?? 0)}
      aria-label={label} aria-rowcount={rows.length + 1} data-cols={columns.length}>
      <div role="row" aria-rowindex={1} className={s.head}>
        <span role="columnheader" className={s.n}>{t("bulkGrid.col.row")}</span>
        <span role="columnheader">{t("bulkGrid.col.number")}</span>
        <span role="columnheader">{t("bulkGrid.col.name")}</span>
        {columns.map((f) => <span key={f.key} role="columnheader" className={s.colHead}>{fieldLabel(f)}<span className={s.tag} data-cls={f.cls}>{t(`bulkGrid.tag.${f.cls}`)}</span></span>)}
        <span role="columnheader">{t("bulkGrid.col.status")}</span>
      </div>
      {first > 0 && <svg height={first * rowHeight} className={m.spacer} aria-hidden />}
      {rows.slice(first, last).map((row, idx) => {
        const r = first + idx;
        const st = statusOf(row);
        return (
          <div key={row.id} role="row" aria-rowindex={r + 2} className={`${s.row} ${m.row}`}>
            <span role="rowheader" className={s.n}>{r + 1}</span>
            <span role="gridcell" className="num">{row.number}</span>
            <span role="gridcell">{row.name}</span>
            {columns.map((f, c) => {
              const cell = row.cells[c]!;
              const typedText = row.typed[c];
              const changed = typedText !== undefined && "send" in cell && typedText.trim() !== row.current[c];
              const bad = "bad" in cell;
              const cellName = t("bulkGrid.cell", { row: r + 1, field: fieldLabel(f) });
              const isEditing = same(editing, r, c);
              const options = isEditing ? pickable(f, typed) : [];
              const listId = `${id(r, c)}-options`;
              return (
                <span
                  key={f.key} id={id(r, c)} role="gridcell" tabIndex={-1} aria-label={cellName} aria-invalid={bad || undefined} className={`${s.cell} ${k.cell}`}
                  data-changed={changed || undefined} data-bad={bad || undefined} data-range={inRange(r, c) || undefined}
                  data-editing={isEditing || undefined} onPaste={(e) => paste(e, r, c)}
                  onFocus={(e) => e.target === e.currentTarget && (same(active, r, c) ? input.current?.focus() : setActive({ r, c }))}
                  onDoubleClick={() => (same(active, r, c) ? begin(r, c, shown(row, c)) : undefined)}
                  onPointerDown={(e) => (e.shiftKey && active?.c === c ? setRange({ col: c, from: active.r, to: r }) : setRange(null))}
                >
                  {!isEditing && changed && <s className={s.old}>{row.current[c] || t("bulkGrid.blank")}</s>}
                  {!isEditing && <span className={changed ? s.new : undefined}>{shown(row, c)}</span>}
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
                  {/* The option Enter takes, shown beside the input; the rest stay in the list for assistive tech (↑↓). */}
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
            <span role="gridcell" className={s.status} data-tone={st.tone}>{st.tone === "error" && <AlertTriangle size={12} aria-hidden />}{st.text}</span>
          </div>
        );
      })}
      {last < rows.length && <svg height={(rows.length - last) * rowHeight} className={m.spacer} aria-hidden />}
      {at && "bad" in at && active && (
        <div className={s.tip} role="status">
          <AlertTriangle size={14} aria-hidden />
          <b>
            {at.bad === "server" ? t("bulkGrid.err.server", { row: active.r + 1, field: fieldLabel(columns[active.c]!), why: refusedText(at.code) })
              : at.bad !== "choice" ? t(`bulkGrid.err.${at.bad}`, { row: active.r + 1, field: fieldLabel(columns[active.c]!) })
              : t("bulkGrid.err.choice", { row: active.r + 1, field: fieldLabel(columns[active.c]!), value: shown(rows[active.r]!, active.c) })}
          </b>
          {at.suggest && <span>{t("bulkGrid.err.suggest", { value: at.suggest })}</span>}
        </div>
      )}
    </div>
  );
}
