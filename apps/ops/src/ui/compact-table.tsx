// SPDX-License-Identifier: LicenseRef-Proprietary
import { useRef, type ReactNode } from "react";
import { useWindowedRows } from "./use-windowed-rows";
import s from "./compact-table.module.css";

export type TableColumn<Row> = {
  id: string;
  header: string;
  mobileSlot?: "badge" | "title" | "meta" | "action" | "omit";
  nowrap?: boolean;
  align?: "left" | "right";
  cellTone?: (row: Row) => "danger" | "warn" | undefined;
  render: (row: Row) => ReactNode;
};

export function CompactTable<Row>({
  caption,
  rows,
  rowKey,
  columns,
  selectedKey,
  onSelectRow,
  mobileCompact = true,
  virtualize = false,
  rowHeight = 40,
}: {
  caption: string;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  columns: readonly TableColumn<Row>[];
  selectedKey?: string;
  onSelectRow?: (row: Row) => void;
  mobileCompact?: boolean;
  virtualize?: boolean;
  rowHeight?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const win = useWindowedRows(rows.length, rowHeight, scrollRef, virtualize);
  const sliced = rows.slice(win.start, win.end);

  return (
    <div className={s.container}>
      <div
        ref={scrollRef}
        className={s.scroll}
        data-virtual={virtualize && rows.length > 40 ? "true" : undefined}
        role="region"
        aria-label={caption}
      >
        <table
          className={`${s.table}${mobileCompact ? ` ${s.compact}` : ""}`}
          data-selectable={onSelectRow ? "true" : undefined}
        >
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.id} className={col.align === "right" ? s.right : undefined}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {win.topHeight > 0 ? (
              <tr
                aria-hidden="true"
                className={s.spacerRow}
                ref={(el) => el?.style.setProperty("--spacer-h", `${win.topHeight}px`)}
              >
                <td colSpan={columns.length}>{" "}</td>
              </tr>
            ) : null}
            {sliced.map((row) => {
              const key = rowKey(row);
              const selected = selectedKey !== undefined && key === selectedKey;
              return (
                <tr
                  key={key}
                  aria-selected={selected ? "true" : undefined}
                  onClick={onSelectRow ? () => onSelectRow(row) : undefined}
                >
                  {columns.map((col) => {
                    const tone = col.cellTone?.(row);
                    const cls = [
                      col.nowrap ? s.nowrap : "",
                      col.align === "right" ? s.right : "",
                      tone === "danger" ? s.cellToneDanger : tone === "warn" ? s.cellToneWarn : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <td
                        key={col.id}
                        className={cls || undefined}
                        data-slot={col.mobileSlot ?? "omit"}
                      >
                        {col.render(row)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {win.bottomHeight > 0 ? (
              <tr
                aria-hidden="true"
                className={s.spacerRow}
                ref={(el) => el?.style.setProperty("--spacer-h", `${win.bottomHeight}px`)}
              >
                <td colSpan={columns.length}>{" "}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
