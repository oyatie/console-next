import { useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { t } from "@console/i18n";
import { parseTsv, type Cell, type GridField } from "../domain/grid";
import { TextInput } from "../../../ui/field/field";
import { refusedText } from "../present";
import { label as enumLabel } from "../../../lib/labels";
import { TYPES } from "../domain/grid";
import { narrow } from "../domain/grid-choices";
import s from "./grid.module.css";
import k from "./grid-input.module.css";

export type GridRow = { id: string; number: string; name: string; current: readonly string[]; typed: readonly (string | undefined)[]; cells: readonly Cell[] };
type Range = { col: number; from: number; to: number } | null;
type At = { r: number; c: number };

const id = (r: number, c: number) => `grid-${r}-${c}`;
const focusCell = (r: number, c: number) => document.getElementById(id(r, c))?.focus();
const same = (a: At | null, r: number, c: number) => a?.r === r && a.c === c;
const TYPE = { type: "employmentType", values: TYPES };
/** Every option of a choice column (sex, employment type), as the grid reads and shows them; none for the others. */
const choiceWords = (f: GridField): readonly string[] =>
  f.kind === "sex" ? [t("bulkGrid.sex.MALE"), t("bulkGrid.sex.FEMALE")] : f.kind === "type" ? TYPES.map((v) => enumLabel(TYPE, v)) : [];
const pickable = (f: GridField, text: string) => narrow(choiceWords(f), text);

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
export function GridTable({ rows, columns, label, onCell, statusOf, fieldLabel, suggestionOf }: {
  rows: readonly GridRow[];
  columns: readonly GridField[];
  label: string;
  onCell: (rowId: string, col: number, text: string) => void;
  statusOf: (r: GridRow) => { tone: "changed" | "error" | "same"; text: string };
  fieldLabel: (f: GridField) => string;
  suggestionOf: (c: Cell) => string | undefined;
}) {
  const [active, setActive] = useState<At | null>(null);
  const [editing, setEditing] = useState<At | null>(null);
  const [typed, setTyped] = useState("");
  const [opt, setOpt] = useState(0);
  const [range, setRange] = useState<Range>(null);
  const input = useRef<HTMLInputElement>(null);
  // What the handlers read (a blur during a move runs before the re-render): the edited cell, and an Enter an IME
  // composition swallowed, applied when the composition ends.
  const editingNow = useRef<At | null>(null);
  const enterAfterIme = useRef(false);
  const startEditing = (r: number, c: number) => ((editingNow.current = { r, c }), setEditing({ r, c }));
  const shown = (row: GridRow, c: number) => row.typed[c] ?? row.current[c] ?? "";
  const inRange = (r: number, c: number) => range && range.col === c && r >= Math.min(range.from, range.to) && r <= Math.max(range.from, range.to);
  // The input moves with the focused cell and takes the focus in the same commit.
  useLayoutEffect(() => void (active && input.current?.focus()), [active]);

  const move = (r: number, c: number) => focusCell(Math.max(0, Math.min(rows.length - 1, r)), Math.max(0, Math.min(columns.length - 1, c)));
  const nextError = (r: number, c: number) => {
    const flat = rows.flatMap((row, ri) => row.cells.map((cell, ci) => ({ ri, ci, bad: "bad" in cell })));
    const after = flat.find((x) => x.bad && (x.ri > r || (x.ri === r && x.ci > c))) ?? flat.find((x) => x.bad);
    if (after) focusCell(after.ri, after.ci);
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
  // Keys while a cell is focused but not edited (the input is empty and unseen).
  const nav = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    const key = e.key;
    if (key === "ArrowDown" && e.shiftKey) {
      e.preventDefault();
      setRange((x) => ({ col: c, from: x?.col === c ? x.from : r, to: Math.min(rows.length - 1, r + 1) }));
      return move(r + 1, c);
    }
    const arrows: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[key]) {
      e.preventDefault();
      setRange(null);
      return move(r + arrows[key]![0], c + arrows[key]![1]);
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

  const at = active && rows[active.r]?.cells[active.c];
  return (
    <div className={s.grid} role="grid" aria-label={label} aria-rowcount={rows.length + 1} data-cols={columns.length}>
      <div role="row" className={s.head}>
        <span role="columnheader" className={s.n}>{t("bulkGrid.col.row")}</span>
        <span role="columnheader">{t("bulkGrid.col.number")}</span>
        <span role="columnheader">{t("bulkGrid.col.name")}</span>
        {columns.map((f) => <span key={f.key} role="columnheader" className={s.colHead}>{fieldLabel(f)}<span className={s.tag} data-cls={f.cls}>{t(`bulkGrid.tag.${f.cls}`)}</span></span>)}
        <span role="columnheader">{t("bulkGrid.col.status")}</span>
      </div>
      {rows.map((row, r) => {
        const st = statusOf(row);
        return (
          <div key={row.id} role="row" className={s.row}>
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
                  key={f.key}
                  id={id(r, c)}
                  role="gridcell"
                  tabIndex={!active && r === 0 && c === 0 ? 0 : -1}
                  aria-label={cellName}
                  aria-invalid={bad || undefined}
                  className={`${s.cell} ${k.cell}`}
                  data-changed={changed || undefined}
                  data-bad={bad || undefined}
                  data-range={inRange(r, c) || undefined}
                  data-editing={isEditing || undefined}
                  onPaste={(e) => paste(e, r, c)}
                  onFocus={(e) => e.target === e.currentTarget && (same(active, r, c) ? input.current?.focus() : setActive({ r, c }))}
                  onDoubleClick={() => (same(active, r, c) ? begin(r, c, shown(row, c)) : undefined)}
                  onPointerDown={(e) => (e.shiftKey && active?.c === c ? setRange({ col: c, from: active.r, to: r }) : setRange(null))}
                >
                  {!isEditing && changed && <s className={s.old}>{row.current[c] || t("bulkGrid.blank")}</s>}
                  {!isEditing && <span className={changed ? s.new : undefined}>{shown(row, c)}</span>}
                  {same(active, r, c) && (
                    <TextInput
                      ref={input}
                      aria-label={cellName}
                      className={isEditing ? k.edit : k.catch}
                      autoComplete="off"
                      role={choiceWords(f).length ? "combobox" : undefined}
                      aria-expanded={choiceWords(f).length ? isEditing : undefined}
                      aria-controls={options.length ? listId : undefined}
                      aria-activedescendant={options.length ? `${listId}-${Math.min(opt, options.length - 1)}` : undefined}
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
