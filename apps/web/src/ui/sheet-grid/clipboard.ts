// SPDX-License-Identifier: LicenseRef-Proprietary
type ClipboardData = Pick<DataTransfer, "getData" | "setData">;

const whitespace = /[\t\n\f\r ]+/g;
const sameCellBreak = (node: Node) => node.nodeName === "BR" && /(?:^|;)\s*mso-data-placement\s*:\s*same-cell\s*(?:;|$)/i.test((node as HTMLElement).getAttribute("style") ?? "");
const cellText = (node: Node): string => Array.from(node.childNodes, (child) => child.nodeType === Node.TEXT_NODE
  ? (child.textContent ?? "").replaceAll("\u00a0", " ").replace(whitespace, " ")
  : child.nodeName === "BR" ? (sameCellBreak(child) ? "\n" : " ") : cellText(child)).join("");
const sameBlock = (a: readonly (readonly string[])[], b: readonly (readonly string[])[]) =>
  a.length === b.length && a.every((row, r) => row.length === b[r]?.length && row.every((value, c) => value === b[r]![c]));

/** Spreadsheet HTML adds in-cell breaks; equivalent plain text keeps the caller's TSV rules. */
export function readClipboard(data: ClipboardData, parseText: (text: string) => readonly (readonly string[])[]) {
  const plain = parseText(data.getData("text/plain"));
  const table = new DOMParser().parseFromString(data.getData("text/html"), "text/html").querySelector("table");
  if (!table) return plain;
  const block = Array.from(table.rows, (row) => Array.from(row.cells, (cell) =>
    cellText(cell).split("\n").map((line) => line.replace(whitespace, " ").trim()).join("\n")));
  return block.length && !sameBlock(block, plain) ? block : plain;
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
