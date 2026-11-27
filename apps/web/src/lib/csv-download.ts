// SPDX-License-Identifier: LicenseRef-Proprietary
import { csvCell } from "./csv-cell";

/** Build a UTF-8 BOM CSV string with formula-safe cells. */
export function buildCsv(
  headers: readonly (string | number)[],
  rows: readonly (readonly (string | number)[])[],
): string {
  const head = headers.map(csvCell).join(",");
  const body = rows.map((row) => row.map(csvCell).join(","));
  return `\uFEFF${[head, ...body].join("\r\n")}\r\n`;
}

/** Trigger a browser download of a formula-safe UTF-8 CSV file. */
export function downloadCsv(
  filename: string,
  headers: readonly (string | number)[],
  rows: readonly (readonly (string | number)[])[],
): void {
  const blob = new Blob([buildCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
