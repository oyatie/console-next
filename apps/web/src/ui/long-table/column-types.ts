// SPDX-License-Identifier: LicenseRef-Proprietary
/** Presentation only: callers format values with the domain's existing formatters. */
export type ColumnType = "text" | "num" | "money" | "pct" | "date" | "time" | "duration" | "code" | "status" | "action";

/** Relative reservations in the column budget; names get room ahead of compact formatted values. */
const COLUMN_WEIGHTS: Record<ColumnType, number> = {
  text: 24, num: 8, money: 12, pct: 6, date: 12, time: 7, duration: 7, code: 12, status: 10, action: 8,
};

/** Share the budget across the columns actually present. Existing explicit sizing stays authoritative. */
export function columnWidths(columns: readonly { type?: ColumnType; width?: unknown }[]): (`${number}%` | undefined)[] {
  if (!columns.some(c => c.type)) return columns.map(() => undefined);
  const explicit = columns.some(c => c.width !== undefined);
  const budget = columns.reduce((sum, c) => sum + COLUMN_WEIGHTS[c.type ?? "text"], 0);
  let cumulative = 0;
  let allocated = 0;
  return columns.map<`${number}%` | undefined>(c => {
    if (explicit) return c.width === undefined && c.type && c.type !== "text" ? `${COLUMN_WEIGHTS[c.type]}%` : undefined;
    cumulative += COLUMN_WEIGHTS[c.type ?? "text"];
    // React Aria accepts only whole percentages; cumulative rounding keeps the total at 100%.
    const end = Math.round(cumulative / budget * 100);
    const width = `${end - allocated}%` as const;
    allocated = end;
    return width;
  });
}

/** Action tables keep their identity and controls together; data-entry grids retain column navigation. */
export function minimumColumnWidth(columns: readonly { width?: unknown; minWidth?: unknown; card?: string; type?: ColumnType }[]): number {
  if (!columns.some(column => column.card === "action" || column.type === "action")) return 0;
  return columns.reduce((width, column) => width + Math.max(typeof column.width === "number" ? column.width : 0, typeof column.minWidth === "number" ? column.minWidth : 0), 0);
}
