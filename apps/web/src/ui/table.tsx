import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cardRoles, type CardColumn } from "./long-table/card-columns";
import cards from "./long-table/table-cards.module.css";
import { columnWidths, type ColumnType } from "./long-table/column-types";
import types from "./long-table/column-types.module.css";

/** `width` reserves a stable share for live content; `fit` shrinks the column to its content (codes, dates, chips); `wide` hides it at phone widths (secondary detail). */
export type Column<R> = CardColumn & { header: ReactNode; cell: (r: R) => ReactNode; type?: ColumnType; fit?: boolean; width?: "code" | "status" | "summary" | "datetime" };
const cls = (c: { fit?: boolean; wide?: boolean }) => [c.fit && "fit", c.wide && "wide-only"].filter(Boolean).join(" ") || undefined;

/**
 * List table. With `onSelect` it is an ARIA grid with a roving row focus: J/K or arrows move focus
 * between rows (only while a row has focus — no global single-key shortcuts, KWCAG 2.2 6.1.4), and
 * Enter, Space or a click selects the focused row.
 * `tone` marks a row that needs attention (a refusal to resolve); `detail` adds a full-width row under a row for
 * what resolves it in place (a name clash and its answers).
 * Bounded lists use this native table; headcount lists use LongTable's server paging and virtualization.
 * Read states belong to the surrounding QueryState boundary; it removes content after a server refusal.
 */
export function Table<R>({ label, rows, columns, rowId, selected, onSelect, tone, detail, groups, density, mobileLayout }: {
  label: string;
  rows: R[];
  columns: Column<R>[];
  rowId: (r: R) => string;
  selected?: string;
  onSelect?: (id: string) => void;
  tone?: (r: R) => "danger" | "warn" | undefined;
  detail?: (r: R) => ReactNode;
  groups?: { id: string; header: ReactNode; rows: R[] }[];
  density?: "regular" | "compact";
  /** Keep row geometry on phones when an editing workflow depends on column alignment. */
  mobileLayout?: "cards" | "rows";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [active, setActive] = useState<string>();
  const [hasEditor, setHasEditor] = useState(false);
  const [scrollState, setScrollState] = useState({ overflows: false, clipped: false, focusable: false });
  const rowsOnPhone = mobileLayout === "rows" || hasEditor;
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const sync = () => {
      const field = table.querySelector('tbody :is(input:not([type="checkbox"]), select, textarea, [contenteditable]:not([contenteditable="false"]))');
      const inlineCheck = table.querySelector('tbody input[type="checkbox"]') && !table.querySelector('thead input[type="checkbox"]');
      const editor = Boolean(field || inlineCheck);
      setHasEditor(editor);
      const scroller = scrollerRef.current;
      const overflows = Boolean(scroller && scroller.scrollWidth > scroller.clientWidth + 1);
      const clipped = Boolean(overflows && scroller && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
      const focusable = editor || Boolean(table.querySelector('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      setScrollState(prev => prev.overflows === overflows && prev.clipped === clipped && prev.focusable === focusable ? prev : { overflows, clipped, focusable });
    };
    const observer = new MutationObserver(sync);
    observer.observe(table, { childList: true, subtree: true });
    const resize = new ResizeObserver(sync);
    resize.observe(table);
    if (containerRef.current) resize.observe(containerRef.current);
    const scroller = scrollerRef.current;
    if (scroller) resize.observe(scroller);
    scroller?.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => {
      observer.disconnect();
      resize.disconnect();
      scroller?.removeEventListener("scroll", sync);
    };
  }, []);
  const ids = (groups ? groups.flatMap(g => g.rows) : rows).map(rowId);
  const current = active && ids.includes(active) ? active : selected && ids.includes(selected) ? selected : ids[0];
  const key = (e: KeyboardEvent) => {
    if (!onSelect || !current) return;
    // Keys typed into a control inside a row (a selection checkbox) belong to that control.
    if (e.target instanceof HTMLElement && e.target.closest("input, select, textarea, button, a")) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(current);
      return;
    }
    const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = ids[Math.min(ids.length - 1, Math.max(0, ids.indexOf(current) + step))]!;
    setActive(next);
    tableRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`)?.focus();
  };
  const scrollableReadOnly = rowsOnPhone && scrollState.overflows && !onSelect && !scrollState.focusable;
  const grid = onSelect ? ({ role: "grid", onKeyDown: key } as const) : {};
  const roles = cardRoles(columns);
  const widths = columnWidths(columns);
  const renderRows = (items: R[]) => items.map((r) => {
    const id = rowId(r);
    const more = detail?.(r);
    return (
      <Fragment key={id}>
      <tr
        data-tone={tone?.(r)}
        data-id={id}
        tabIndex={onSelect ? (id === current ? 0 : -1) : undefined}
        aria-selected={onSelect ? id === selected : undefined}
        onFocus={onSelect && (() => setActive(id))}
        onClick={onSelect && (() => onSelect(id))}
      >
        {columns.map((c, i) => {
          const value = c.cell(r);
          return <td role={onSelect ? "gridcell" : "cell"} key={i} className={cls(c)} data-type={c.type} data-card={roles[i]} data-label={typeof c.header === "string" ? c.header : undefined} title={typeof value === "string" ? value : undefined}>{value}</td>;
        })}
      </tr>
      {more != null && more !== false && (
        <tr className="table__detail" data-tone={tone?.(r)}>
          <td colSpan={columns.length}>{more}</td>
        </tr>
      )}
      </Fragment>
    );
  });
  const table = (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Overflowing read-only tables without focusable cells need keyboard scroll access.
    <table ref={tableRef} tabIndex={scrollableReadOnly ? 0 : undefined} className={`table ${rowsOnPhone ? cards.rows : cards.short} ${cards.surface} ${types.surface} ${types.native}`} data-typed={columns.some(c => c.type) || undefined} data-density={density} data-fixed={columns.some(c => c.width !== undefined) || undefined} data-selectable={Boolean(onSelect)} {...grid}>
      <caption className="sr-only">{label}</caption>
      {columns.some(c => c.type) && <colgroup>{columns.map((c, i) => <col key={i} className={cls(c)} ref={el => { if (el) el.style.width = widths[i] ?? ""; }} />)}</colgroup>}
      <thead>
        <tr>{columns.map((c, i) => <th key={i} scope="col" className={cls(c)} data-type={c.type} data-width={c.width}>{c.header}</th>)}</tr>
      </thead>
      {groups ? groups.map(g => (
        <tbody key={g.id}>
          <tr><th scope="rowgroup" colSpan={columns.length}>{g.header}</th></tr>
          {renderRows(g.rows)}
        </tbody>
      )) : <tbody>{renderRows(rows)}</tbody>}
    </table>
  );
  return (
    <div ref={containerRef} className={cards.container}>
      <div ref={scrollerRef} className={rowsOnPhone ? cards.scroll : undefined}>{table}</div>
      {rowsOnPhone && scrollState.clipped && <span className={cards.scrollCue} data-scroll-cue aria-hidden="true" />}
    </div>
  );
}
