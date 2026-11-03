// SPDX-License-Identifier: LicenseRef-Proprietary
type ClipboardData = Pick<DataTransfer, "getData" | "setData">;

/** Spreadsheet clipboard HTML is authoritative when it contains a table; plain text keeps the caller's TSV rules. */
export function readClipboard(data: ClipboardData, parseText: (text: string) => readonly (readonly string[])[]) {
  const table = new DOMParser().parseFromString(data.getData("text/html"), "text/html").querySelector("table");
  if (!table) return parseText(data.getData("text/plain"));
  const block = Array.from(table.rows, (row) => Array.from(row.cells, (cell) => {
    const copy = cell.cloneNode(true) as HTMLTableCellElement;
    copy.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    return (copy.textContent ?? "").replaceAll("\u00a0", " ");
  }));
  return block.length ? block : parseText(data.getData("text/plain"));
}

const quoteTsv = (value: string) => /["\t\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** Writes both clipboard formats Excel and browser spreadsheets consume, using displayed cell text only. */
export function writeClipboard(data: ClipboardData, cells: readonly (readonly string[])[]) {
  data.setData("text/plain", cells.map((row) => row.map(quoteTsv).join("\t")).join("\r\n"));
  const table = document.createElement("table");
  for (const row of cells) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const td = document.createElement("td");
      value.split(/\r?\n/).forEach((line, index) => {
        if (index) td.append(document.createElement("br"));
        td.append(line);
      });
      tr.append(td);
    }
    table.append(tr);
  }
  data.setData("text/html", table.outerHTML);
}
