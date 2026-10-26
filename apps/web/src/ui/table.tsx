import { Fragment, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cardRoles, type CardColumn } from "./long-table/card-columns";
import cards from "./long-table/table-cards.module.css";

/** `width` reserves a stable share for live content; `fit` shrinks the column to its content (codes, dates, chips); `wide` hides it at phone widths (secondary detail). */
export type Column<R> = CardColumn & { header: ReactNode; cell: (r: R) => ReactNode; fit?: boolean; width?: "code" | "status" | "summary" | "datetime" };
const cls = (c: { fit?: boolean; wide?: boolean }) => [c.fit && "fit", c.wide && "wide-only"].filter(Boolean).join(" ") || undefined;

/**
 * List table. With `onSelect` it is an ARIA grid with a roving row focus: J/K or arrows move focus
 * between rows (only while a row has focus — no global single-key shortcuts, KWCAG 2.2 6.1.4), and
 * Enter, Space or a click selects the focused row.
 * `tone` marks a row that needs attention (a refusal to resolve); `detail` adds a full-width row under a row for
 * what resolves it in place (a name clash and its answers).
 * plain <table>; switch to TanStack Table + Virtual when a list needs sorting or >1k rows.
 */
export function Table<R>({ label, rows, columns, rowId, selected, onSelect, tone, detail }: {
  label: string;
  rows: R[];
  columns: Column<R>[];
  rowId: (r: R) => string;
  selected?: string;
  onSelect?: (id: string) => void;
  tone?: (r: R) => "danger" | "warn" | undefined;
  detail?: (r: R) => ReactNode;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const [active, setActive] = useState<string>();
  const ids = rows.map(rowId);
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
    body.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`)?.focus();
  };
  const grid = onSelect ? ({ role: "grid", onKeyDown: key } as const) : {};
  const roles = cardRoles(columns);
  const hasCards = columns.some(c => c.card);
  const table = (
    <table className={`table ${hasCards ? cards.short : ""} ${cards.surface}`} data-fixed={columns.some(c => c.width !== undefined) || undefined} data-selectable={Boolean(onSelect)} aria-label={label} {...grid}>
      <thead>
        <tr>{columns.map((c, i) => <th key={i} className={cls(c)} data-width={c.width}>{c.header}</th>)}</tr>
      </thead>
      <tbody ref={body}>
        {rows.map((r) => {
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
              {columns.map((c, i) => <td role={onSelect ? "gridcell" : "cell"} key={i} className={cls(c)} data-card={roles[i]} data-label={typeof c.header === "string" ? c.header : undefined}>{c.cell(r)}</td>)}
            </tr>
            {more != null && more !== false && (
              <tr className="table__detail" data-tone={tone?.(r)}>
                <td colSpan={columns.length}>{more}</td>
              </tr>
            )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
  return hasCards ? <div className={cards.container}>{table}</div> : table;
}
