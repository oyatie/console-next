import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Cell, Checkbox, Collection, Column, Input, Label, ResizableTableContainer, Row, SearchField, Table, TableBody, TableHeader, TableLayout, TableLoadMoreItem, Virtualizer, type CellProps, type ColumnProps, type SortDescriptor } from "react-aria-components";
import { ArrowDown, ArrowUp } from "lucide-react";
import { t } from "@console/i18n";
import { ALL_MATCHING, NO_SELECTION, applyKeys, selectionCount, shownKeys, type Selection } from "./selection";
import { DisabledReason } from "../disabled-reason/disabled-reason";
import { listenRowKeys, rowIdOf } from "./row-keys";
import css from "./long-table.module.css";
import cards from "./table-cards.module.css";
import type { CardColumn } from "./card-columns";
import { CardContent } from "./card-content";
import { useCardLayout } from "./use-card-layout";
import { SelectInput } from "../field/select-input";
import { columnWidths, type ColumnType } from "./column-types";
import types from "./column-types.module.css";

// Native design-system controls participate in the table's focus management.
export { Focusable as TableControl } from "react-aria-components";

const NONE = new Set<string>();

/** `width` is a React Aria column size: "1fr" (default), "2fr", a percentage, or px for codes and dates. */
export type LongColumn<R> = CardColumn & { id: string; header: ReactNode; cell: (r: R) => ReactNode; type?: ColumnType; focusMode?: CellProps["focusMode"]; allowsSorting?: boolean; width?: ColumnProps["width"]; minWidth?: ColumnProps["minWidth"] };

const SELECT = "__select";
// React Aria shares one collection key space between rows and columns.
const rowKey = (id: string) => `row:${id}`;
const rowId = (key: string | number) => String(key).slice("row:".length);
// TableLayout needs pixel estimates; CSS measures each row so cards can wrap and desktop densities stay fixed.
const LAYOUT = {
  regular: { estimatedRowHeight: 40, headingHeight: 40, loaderHeight: 40 },
  compact: { estimatedRowHeight: 32, headingHeight: 36, loaderHeight: 32 },
};
const SELECT_WIDTH = 48;
/** Placeholder rows while the first page loads (long-table.module.css sizes the table to fit them). */
const SKELETON_ROWS = 8;

/**
 * A long server list (3,000+ rows): React Aria Table + Virtualizer + TableLayout, so only visible rows are in the
 * DOM while the sticky header and grid keys stay. More rows load through TableLoadMoreItem; paging lives in the
 * caller's infinite query (ui/ knows no data layer).
 *
 * Find: browser find cannot see unrendered rows, so `/` (only while focus is inside this table's region; no
 * global single-key shortcut, KWCAG 2.2 6.1.4) focuses the in-app search, and Enter hands the text to `onFind`
 * (server search, or a jump to an exact employee number; the caller decides). With `rowKeys`, J/K move between
 * rows and O opens the focused one, in the region only; the bar names the keys.
 *
 * Selection: the header checkbox takes the loaded rows; selecting every row matching the filter is an explicit
 * action and becomes a server-side selection (filter + exclusions; see selection.ts). With `selectAllLimit`, a
 * filter matching more rows than one command takes offers that action disabled, with why beside it.
 */
export function LongTable<R>(p: {
  label: string;
  columns: LongColumn<R>[];
  /** Controlled by the caller's server query; the table never reorders a loaded page. */
  sortDescriptor?: SortDescriptor;
  onSortChange?: (sort: SortDescriptor) => void;
  rows: R[];
  rowId: (r: R) => string;
  /** Server count after Cedar and filtering; null means unknown, omitted falls back to paging completion. */
  total?: number | null;
  /** One-based position in the server result, excluding the header; defaults to a contiguous loaded prefix. */
  rowIndex?: (r: R) => number;
  /** A count line for the header (employees: 3,214). */
  caption?: ReactNode;
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
  /** First page in flight: a placeholder of the table's shape (its columns, a screenful of rows) after the skeleton delay. */
  loading?: boolean;
  empty: ReactNode;
  density?: "regular" | "compact";
  /** Editing rows grow with validation messages. */
  editable?: boolean;
  onRowAction?: (id: string) => void;
  /** Prefetch hooks: the pointer entered a row, or a row took focus. */
  onRowHover?: (id: string) => void;
  onRowFocus?: (id: string) => void;
  find?: { label: string; onFind: (q: string) => void; defaultValue?: string };
  /**
   * Where the search sits instead of this table's own bar (a filter band above it): the bar then keeps only the caption
   * (none: no bar). `null` while that place is not mounted yet. `/` from inside the table still focuses it.
   */
  findSlot?: HTMLElement | null;
  /** J/K row moves and O to open (`onOpen`, else `onRowAction`). */
  rowKeys?: { onOpen?: (id: string) => void };
  selection?: Selection;
  onSelectionChange?: (s: Selection) => void;
  selectAllLimit?: { max: number; reason?: ReactNode; remedy?: ReactNode };
  /** What to do with the selection (the bulk command), after the count. */
  selectionActions?: ReactNode;
  /** "person": the selection counts people, not items. */
  countUnit?: "person";
  /** The scrolling element, for a caller that restores the scroll position. */
  scrollRef?: (el: HTMLElement | null) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const region = useRef<HTMLElement>(null);
  const grid = useRef<HTMLElement | null>(null);
  const hasCards = p.columns.some(c => c.card);
  const cardLayout = useCardLayout(region, grid) && hasCards;
  const { sortDescriptor: sort, onSortChange } = p;
  const sortable = p.columns.filter(column => column.allowsSorting);
  const [cardHeight, setCardHeight] = useState<number>();
  useLayoutEffect(() => {
    const table = grid.current;
    if (!cardLayout || !table) return;
    const resize = new ResizeObserver(([entry]) => {
      const height = entry?.target.scrollHeight;
      if (height) setCardHeight(height);
    });
    const measure = () => {
      const card = table.querySelector<HTMLElement>(`.${cards.content}`);
      resize.disconnect();
      if (!card) return;
      resize.observe(card);
      const height = card.scrollHeight;
      if (height) setCardHeight(height);
    };
    // Virtualization replaces the first rendered card as the user scrolls.
    const rows = new MutationObserver(measure);
    rows.observe(table, { childList: true, subtree: true });
    measure();
    return () => { resize.disconnect(); rows.disconnect(); };
  }, [cardLayout]);
  const captionId = useId();
  const open = p.rowKeys?.onOpen ?? p.onRowAction;
  const hasFind = Boolean(p.find);
  const hasRowKeys = Boolean(p.rowKeys);
  const handlers = useRef({ open, focus: p.onRowFocus });
  useEffect(() => void (handlers.current = { open, focus: p.onRowFocus }));
  useEffect(() => {
    const el = region.current;
    if (!el) return;
    // Focus landed in a body row: the row itself, or a cell or checkbox in it (a click focuses the cell, and the
    // arrows then move cell to cell). Only body rows carry the caller's row id.
    const focus = (e: FocusEvent) => {
      const id = rowIdOf(e.target);
      if (id) handlers.current.focus?.(id);
    };
    el.addEventListener("focusin", focus);
    const keys = hasFind || hasRowKeys
      ? listenRowKeys(el, {
          find: hasFind ? () => search.current?.focus() : undefined,
          rows: hasRowKeys ? { grid: () => grid.current, onOpen: (id) => handlers.current.open?.(id) } : undefined,
        })
      : undefined;
    return () => (el.removeEventListener("focusin", focus), keys?.());
  }, [hasFind, hasRowKeys]);
  const density = p.density ?? "regular";
  const layout = useMemo(() => cardLayout && cardHeight ? { ...LAYOUT[density], estimatedRowHeight: cardHeight }
    : p.editable ? { ...LAYOUT[density], estimatedRowHeight: LAYOUT[density].estimatedRowHeight * 2 } : LAYOUT[density], [cardLayout, cardHeight, density, p.editable]);
  const loaded = p.rows.map(p.rowId);
  const indices = new Map(p.rows.map((r, i) => [p.rowId(r), p.rowIndex?.(r) ?? i + 1]));
  const sel = p.selection;
  const selected = sel ? shownKeys(sel, loaded) : NONE;
  const titleId = (r: R) => `${captionId}-${encodeURIComponent(p.rowId(r))}-title`;
  const content: LongColumn<R>[] = cardLayout ? [{ id: "__card", header: p.label, rowHeader: true, cell: (r) => <CardContent row={r} columns={p.columns} titleId={titleId(r)} /> }] : p.columns;
  const cols: LongColumn<R>[] = sel ? [{ id: SELECT, header: null, cell: () => null, width: SELECT_WIDTH }, ...content] : content;
  const widths = columnWidths(cols);
  const slotted = p.findSlot !== undefined;
  const [find, setFind] = useState({ source: p.find?.defaultValue, value: p.find?.defaultValue ?? "" });
  if (find.source !== p.find?.defaultValue) setFind({ source: p.find?.defaultValue, value: p.find?.defaultValue ?? "" });
  const finder = p.find && (
    <SearchField className={css.find} value={find.value} onChange={value => setFind({ source: p.find?.defaultValue, value })} onSubmit={p.find.onFind} onClear={() => p.find?.onFind("")}>
      <Label className="sr-only">{p.find.label}</Label>
      <Input ref={search} className="field__input" placeholder={p.find.label} />
      <kbd className={css.kbd} aria-hidden="true">/</kbd>
    </SearchField>
  );
  return (
    <section ref={region} className={`${css.region} ${hasCards ? cards.container : ""}`} aria-label={p.label} data-density={density}
      onKeyDownCapture={(e) => {
        if (!cardLayout || e.key !== "Enter" || !p.onRowAction || !(e.target instanceof HTMLElement) || !e.target.matches('[role="row"], [role="rowheader"], [role="gridcell"]')) return;
        const id = rowIdOf(e.target);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        p.onRowAction(id);
      }}>
      {(!slotted || p.caption != null) && (
        <div className={css.bar}>
          {/* Held while the count loads: the hints and the search beside it must not slide over when it lands. */}
          <span id={captionId} className={css.caption}>{p.caption}</span>
          {!slotted && finder}
        </div>
      )}
      {slotted && p.findSlot && finder && createPortal(finder, p.findSlot)}
      {cardLayout && sort && onSortChange && sortable.length > 0 && (
        <div className={css.bar}>
          <label className={css.sort}>{t("uiLongTable.sort")}
            <SelectInput value={sort.column} onChange={e => onSortChange({ column: e.target.value, direction: sort.direction })}>
              {sortable.map(column => <option key={column.id} value={column.id}>{column.header}</option>)}
            </SelectInput>
          </label>
          <Button className="btn" onPress={() => onSortChange({ column: sort.column, direction: sort.direction === "ascending" ? "descending" : "ascending" })}>
            {sort.direction === "ascending" ? <ArrowDown size={14} aria-hidden /> : <ArrowUp size={14} aria-hidden />}
            {t(sort.direction === "ascending" ? "uiLongTable.descending" : "uiLongTable.ascending")}
          </Button>
        </div>
      )}
      {sel && p.onSelectionChange && (
        <SelectionBar sel={sel} loaded={loaded.length} total={p.total ?? undefined} hasMore={p.hasMore} limit={p.selectAllLimit} actions={p.selectionActions} unit={p.countUnit ?? "item"} onChange={p.onSelectionChange} />
      )}
      <ResizableTableContainer>
      <Virtualizer layout={TableLayout} layoutOptions={layout}>
        <Table
          ref={(el) => {
            grid.current = el;
            p.scrollRef?.(el);
          }}
          aria-label={p.label}
          // React Aria derives these attributes from loaded rows; the server result includes unloaded rows.
          render={props => <div {...props} aria-rowcount={p.total === undefined ? (p.hasMore ? -1 : loaded.length + 1) : p.total === null ? -1 : p.total + 1} />}
          aria-describedby={p.caption ? captionId : undefined}
          className={`${css.table} ${cards.surface} ${types.surface}`}
          data-layout={cardLayout ? "cards" : "rows"}
          data-editable={p.editable || undefined}
          data-total={p.total}
          // RAC's tab mode keeps typing and caret keys in cell controls, including tables without editable row sizing.
          keyboardNavigationBehavior="tab"
          sortDescriptor={p.sortDescriptor}
          onSortChange={p.onSortChange}
          // An empty virtualized body is as tall as the viewport, so give the empty and loading states a height.
          data-state={p.rows.length ? undefined : p.loading ? "loading" : "empty"}
          selectionMode={sel ? "multiple" : "none"}
          selectionBehavior="toggle"
          // Always controlled (empty without a selection): a selection that arrives with the permissions would otherwise
          // switch React Aria from uncontrolled to controlled.
          selectedKeys={selected === "all" ? selected : new Set([...selected].map(rowKey))}
          onSelectionChange={(keys) => sel && p.onSelectionChange?.(applyKeys(sel, keys === "all" ? keys : new Set([...keys].map(rowId)), loaded))}
          onRowAction={p.onRowAction && ((k) => p.onRowAction?.(rowId(k)))}
          // Esc never drops a selection that took many clicks to build; the caller's Esc (closing a panel) runs.
          {...({ escapeKeyBehavior: "none" } as object)}
        >
          <TableHeader className={css.head} columns={cols}>
            {(c) => (
              <Column id={c.id} data-type={c.type} isRowHeader={c.rowHeader} allowsSorting={Boolean(p.onSortChange && c.allowsSorting)} width={c.width ?? widths[cols.findIndex(col => col.id === c.id)] ?? "1fr"} minWidth={c.minWidth ?? (c.type ? 0 : undefined)} className={css.th}>
                {({ sortDirection }) => c.id === SELECT ? <Checkbox slot="selection" className={css.check}><Box /></Checkbox> : <>{c.header}{sortDirection === "ascending" ? <ArrowUp size={14} aria-hidden /> : sortDirection === "descending" ? <ArrowDown size={14} aria-hidden /> : null}</>}
              </Column>
            )}
          </TableHeader>
          <TableBody
            className={css.body}
            renderEmptyState={() =>
              p.loading ? <Skeleton columns={cols.length} rows={SKELETON_ROWS} /> : <div className={css.empty}>{p.empty}</div>
            }
          >
            <Collection items={p.rows} dependencies={[cols]}>
              {(r) => {
                const id = p.rowId(r);
                return (
                  <Row id={rowKey(id)} columns={cols} className={css.row} render={props => <div {...props} data-row-id={id} aria-rowindex={indices.get(id)! + 1} />} onHoverStart={p.onRowHover && (() => p.onRowHover?.(id))}>
                    {(c) => {
                      const render = () => c.id === SELECT ? <Checkbox slot="selection" className={css.check}><Box /></Checkbox> : c.cell(r);
                      // Collection metadata needs row names; offscreen form controls can wait for a visible cell.
                      const value = p.editable && !c.rowHeader ? render : render();
                      return <Cell data-type={c.type} focusMode={c.focusMode} className={css.td} render={props => <div {...props} title={typeof value === "string" ? value : undefined} aria-labelledby={cardLayout && c.id === "__card" ? titleId(r) : props["aria-labelledby"]} />}>{value}</Cell>;
                    }}
                  </Row>
                );
              }}
            </Collection>
            {p.hasMore && (
              <TableLoadMoreItem className={css.more} onLoadMore={p.onLoadMore} isLoading={p.loadingMore}>
                {t("uiLongTable.loadingMore")}
              </TableLoadMoreItem>
            )}
          </TableBody>
        </Table>
      </Virtualizer>
      </ResizableTableContainer>
    </section>
  );
}

const Box = () => <span className={css.box} aria-hidden="true" />;

/**
 * The first page's placeholder: the table's columns and rows as grey bars, announced once as loading. CSS shows
 * the bars only after `display.skeleton_delay` (200 ms, the animation delay), so a fast load never flashes.
 */
function Skeleton({ columns, rows }: { columns: number; rows: number }) {
  return (
    <div className={css.skeleton} role="status">
      <span className="sr-only">{t("uiLongTable.loading")}</span>
      {Array.from({ length: rows }, (_r, i) => (
        <div key={i} className={css.skeletonRow} aria-hidden="true">
          {Array.from({ length: columns }, (_c, j) => <span key={j} className={css.skeletonCell} />)}
        </div>
      ))}
    </div>
  );
}

/** The selected count, the explicit select-all-matching action (or why not), the caller's actions, and how to clear. */
function SelectionBar({ sel, loaded, total, hasMore, limit, actions, unit, onChange }: {
  sel: Selection;
  loaded: number;
  total?: number;
  hasMore: boolean;
  limit?: { max: number; reason?: ReactNode; remedy?: ReactNode };
  actions?: ReactNode;
  unit: string;
  onChange: (s: Selection) => void;
}) {
  const count = selectionCount(sel, total ?? loaded);
  if (count === 0) return null;
  const offerAll = sel.kind === "ids" && hasMore && total !== undefined && sel.ids.size === loaded && total > loaded;
  const tooMany = offerAll && limit !== undefined && total! > limit.max;
  return (
    <div className={css.selection}>
      <span role="status">
        {sel.kind === "all"
          ? t("uiLongTable.selection.all", { count, excluded: sel.excluded.size, unit })
          : t("uiLongTable.selection.ids", { count, unit })}
      </span>
      {offerAll && !tooMany && <Button className="btn btn--ghost" onPress={() => onChange(ALL_MATCHING)}>{t("uiLongTable.selection.selectAll", { total, unit })}</Button>}
      {tooMany && (
        <DisabledReason
          layout="inline"
          reason={limit.reason ?? t("uiLongTable.selection.tooMany", { total, max: limit.max })}
          remedy={limit.remedy}
          control={(d) => <button {...d} className={`btn btn--ghost ${d.className ?? ""}`}>{t("uiLongTable.selection.selectAll", { total, unit })}</button>}
        />
      )}
      {actions}
      <Button className="btn btn--ghost" onPress={() => onChange(NO_SELECTION)}>{t("uiLongTable.selection.clear")}</Button>
    </div>
  );
}
