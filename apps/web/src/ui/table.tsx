import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cardRoles, type CardColumn } from "./long-table/card-columns";
import cards from "./long-table/table-cards.module.css";
import { columnWidths, type ColumnType } from "./long-table/column-types";
import types from "./long-table/column-types.module.css";
import { rowStep } from "./long-table/row-keys";

/** `width` reserves a stable share for live content; `fit` shrinks the column to its content (codes, dates, chips); `wide` hides it at phone widths (secondary detail). */
export type Column<R> = CardColumn & {
  header: ReactNode;
  cell: (r: R) => ReactNode;
  type?: ColumnType;
  fit?: boolean;
  width?: "code" | "status" | "summary" | "datetime";
  emphasis?: "strong";
  cellTone?: (r: R) => "danger" | "warn" | "ok" | undefined;
  /** Pins trailing columns to the inline-end edge when wide tables scroll horizontally above phone width. */
  pin?: "end";
};
type TableColumnGroup = { key: string; label?: ReactNode; span: number };
type TableFooterCell = {
  key: string;
  content: ReactNode;
  span?: number;
  type?: ColumnType;
  emphasis?: "strong";
  card?: "label" | "value" | "meta" | "omit";
  pin?: "end";
};
type TableFooterRow = { key?: string; cells: readonly TableFooterCell[] };
const cls = (c: { fit?: boolean; wide?: boolean }) => [c.fit && "fit", c.wide && "wide-only"].filter(Boolean).join(" ") || undefined;

function computeGroupPins<R>(
  columnGroups: readonly TableColumnGroup[] | undefined,
  columns: readonly Column<R>[],
): readonly { pin?: "end"; pinFirst?: "true" }[] {
  if (!columnGroups?.length) return [];
  const out: { pin?: "end"; pinFirst?: "true" }[] = [];
  let colIdx = 0;
  for (const g of columnGroups) {
    const slice = columns.slice(colIdx, colIdx + g.span);
    const allPinned = slice.length > 0 && slice.every(c => c.pin === "end");
    const pinFirst = allPinned && columns[colIdx - 1]?.pin !== "end" ? ("true" as const) : undefined;
    out.push({ pin: allPinned ? ("end" as const) : undefined, pinFirst });
    colIdx += g.span;
  }
  return out;
}

/**
 * List table. With `onSelect` it is an ARIA grid with a roving row focus: J/K or arrows move focus
 * between rows (only while a row has focus — no global single-key shortcuts, KWCAG 2.2 6.1.4), and
 * Enter, Space or a click selects the focused row.
 * `tone` marks a row that needs attention (a refusal to resolve); `detail` adds a full-width row under a row for
 * what resolves it in place (a name clash and its answers).
 * Bounded lists use this native table; headcount lists use LongTable's server paging and virtualization.
 * Read states belong to the surrounding QueryState boundary; it removes content after a server refusal.
 */
export function Table<R>({ label, rows, columns, rowId, selected, onSelect, onOpen, tone, detail, groups, columnGroups, footerRow, scrollLayout, density, mobileLayout, tableClassName, groupedStyles }: {
  label: string;
  rows: R[];
  columns: Column<R>[];
  rowId: (r: R) => string;
  selected?: string;
  onSelect?: (id: string) => void;
  onOpen?: (id: string) => void;
  tone?: (r: R) => "danger" | "warn" | undefined;
  detail?: (r: R) => ReactNode;
  groups?: { id: string; header: ReactNode; rows: R[] }[];
  columnGroups?: readonly TableColumnGroup[];
  footerRow?: TableFooterRow;
  scrollLayout?: "auto" | "fixed";
  density?: "regular" | "compact";
  /** Override the automatic phone layout: rows preserve column alignment, cards keep inline forms in view, compact draws 2-line operational rows. */
  mobileLayout?: "cards" | "rows" | "compact";
  tableClassName?: string;
  groupedStyles?: { groupRow?: string; groupCell?: string; groupBlank?: string; footerRow?: string };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [active, setActive] = useState<string>();
  const [hasEditor, setHasEditor] = useState(false);
  const [scrollState, setScrollState] = useState({ overflows: false, clipped: false, focusable: false, phone: false });
  const rowsOnPhone = mobileLayout === "rows" || (mobileLayout !== "cards" && mobileLayout !== "compact" && hasEditor);
  const compactOnPhone = mobileLayout === "compact";
  const hasPinnedEnd = columns.some(c => c.pin === "end");
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const sync = () => {
      const phone = (containerRef.current?.clientWidth ?? 1440) <= 480;
      const headPinned = [...table.querySelectorAll<HTMLElement>('thead tr:last-child > [data-pin="end"]')];
      if (phone || headPinned.length === 0) {
        for (const el of table.querySelectorAll<HTMLElement>('[data-pin="end"]')) {
          if (el.style.insetInlineEnd) el.style.insetInlineEnd = "";
        }
      } else {
        const offsets = new Array<number>(headPinned.length).fill(0);
        let acc = 0;
        for (let i = headPinned.length - 1; i >= 0; i--) {
          offsets[i] = acc;
          acc += Math.round(headPinned[i]!.getBoundingClientRect().width);
        }
        for (const row of table.querySelectorAll("thead tr, tbody tr, tfoot tr")) {
          const cells = [...row.querySelectorAll<HTMLElement>(':scope > [data-pin="end"]')];
          if (cells.length === headPinned.length) {
            cells.forEach((cell, idx) => {
              const val = `${offsets[idx]}px`;
              if (cell.style.insetInlineEnd !== val) cell.style.insetInlineEnd = val;
            });
          } else if (cells.length === 1) {
            if (cells[0]!.style.insetInlineEnd !== "0px") cells[0]!.style.insetInlineEnd = "0px";
          }
        }
      }
      const field = table.querySelector('tbody :is(input:not([type="checkbox"]), select, textarea, [contenteditable]:not([contenteditable="false"]))');
      const inlineCheck = table.querySelector('tbody input[type="checkbox"]') && !table.querySelector('thead input[type="checkbox"]');
      const editor = Boolean(field || inlineCheck);
      setHasEditor(editor);
      const scroller = scrollerRef.current;
      const overflows = Boolean(scroller && scroller.scrollWidth > scroller.clientWidth + 1);
      const clipped = Boolean(overflows && scroller && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
      const focusable = editor || Boolean(table.querySelector('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      setScrollState(prev =>
        prev.overflows === overflows && prev.clipped === clipped && prev.focusable === focusable && prev.phone === phone
          ? prev
          : { overflows, clipped, focusable, phone },
      );
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
      if (e.key === "Enter" && current === selected && onOpen) onOpen(current);
      else onSelect(current);
      return;
    }
    const step = rowStep(e.nativeEvent);
    if (!step) return;
    e.preventDefault();
    const next = ids[Math.min(ids.length - 1, Math.max(0, ids.indexOf(current) + step))]!;
    setActive(next);
    tableRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`)?.focus();
  };
  const scrollableReadOnly = scrollState.overflows && !onSelect && !scrollState.focusable;
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
        onClick={onSelect && (e => {
          if (e.target instanceof HTMLElement && e.target.closest('label.check, input[type="checkbox"]')) return;
          onSelect(id);
        })}
      >
        {columns.map((c, i) => {
          const value = c.cell(r);
          const pinFirst = c.pin === "end" && columns[i - 1]?.pin !== "end" ? "true" : undefined;
          return <td role={onSelect ? "gridcell" : "cell"} key={i} className={cls(c)} data-type={c.type} data-emphasis={c.emphasis} data-cell-tone={c.cellTone?.(r)} data-pin={c.pin} data-pin-first={pinFirst} data-card={roles[i]} data-label={typeof c.header === "string" ? c.header : undefined} title={typeof value === "string" ? value : undefined}>{value}</td>;
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
  const fixedTyped = columns.some(c => c.type) && scrollLayout !== "auto";
  const groupPins = computeGroupPins(columnGroups, columns);
  const table = (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Overflowing read-only tables without focusable cells need keyboard scroll access.
    <table ref={tableRef} tabIndex={scrollableReadOnly ? 0 : undefined} className={`table ${rowsOnPhone ? cards.rows : compactOnPhone ? cards.compact : cards.short} ${cards.surface} ${types.surface} ${types.native}${tableClassName ? ` ${tableClassName}` : ""}`} data-typed={columns.some(c => c.type) || undefined} data-scroll-layout={scrollLayout} data-density={density} data-compact-rows={compactOnPhone || undefined} data-fixed={columns.some(c => c.width !== undefined) || undefined} data-selectable={Boolean(onSelect)} {...grid}>
      <caption className="sr-only">{label}</caption>
      {fixedTyped && <colgroup>{columns.map((c, i) => <col key={i} className={cls(c)} ref={el => { if (el) el.style.width = widths[i] ?? ""; }} />)}</colgroup>}
      <thead>
        {columnGroups?.length ? (
          <tr className={groupedStyles?.groupRow}>
            {columnGroups.map((g, gi) => (
              g.label != null
                ? <th key={g.key} scope="colgroup" colSpan={g.span} data-pin={groupPins[gi]?.pin} data-pin-first={groupPins[gi]?.pinFirst} className={groupedStyles?.groupCell}>{g.label}</th>
                : <td key={g.key} colSpan={g.span} data-pin={groupPins[gi]?.pin} data-pin-first={groupPins[gi]?.pinFirst} className={groupedStyles?.groupBlank} aria-hidden="true" />
            ))}
          </tr>
        ) : null}
        <tr>{columns.map((c, i) => <th key={i} scope="col" className={cls(c)} data-type={c.type} data-width={c.width} data-pin={c.pin} data-pin-first={c.pin === "end" && columns[i - 1]?.pin !== "end" ? "true" : undefined}>{c.header}</th>)}</tr>
      </thead>
      {groups ? groups.map(g => (
        <tbody key={g.id}>
          <tr><th scope="rowgroup" colSpan={columns.length}>{g.header}</th></tr>
          {renderRows(g.rows)}
        </tbody>
      )) : <tbody>{renderRows(rows)}</tbody>}
      {footerRow && footerRow.cells.length > 0 && (
        <tfoot>
          <tr key={footerRow.key ?? "footer"} className={groupedStyles?.footerRow}>
            {footerRow.cells.map((cell, i) => {
              const pinFirst = cell.pin === "end" && footerRow.cells[i - 1]?.pin !== "end" ? "true" : undefined;
              return i === 0
                ? <th key={cell.key} scope="row" colSpan={cell.span} data-type={cell.type} data-emphasis={cell.emphasis} data-pin={cell.pin} data-pin-first={pinFirst} data-card={cell.card}>{cell.content}</th>
                : <td key={cell.key} colSpan={cell.span} data-type={cell.type} data-emphasis={cell.emphasis} data-pin={cell.pin} data-pin-first={pinFirst} data-card={cell.card}>{cell.content}</td>;
            })}
          </tr>
        </tfoot>
      )}
    </table>
  );
  const showScrollCue = scrollState.clipped && (!hasPinnedEnd || scrollState.phone);
  return (
    <div ref={containerRef} className={cards.container}>
      <div ref={scrollerRef} className={rowsOnPhone || scrollState.overflows ? cards.scroll : undefined}>{table}</div>
      {showScrollCue && <span className={cards.scrollCue} data-scroll-cue aria-hidden="true" />}
    </div>
  );
}
