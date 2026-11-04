// SPDX-License-Identifier: LicenseRef-Proprietary
type ClipboardData = Pick<DataTransfer, "getData" | "setData">;

const whitespace = /[\t\n\f\r ]+/g;
const sameCellBreak = (node: Node) => node.nodeName === "BR" && /(?:^|;)\s*mso-data-placement\s*:\s*same-cell\s*(?:;|$)/i.test((node as HTMLElement).getAttribute("style") ?? "");
const cellLines = (node: Node) => {
  const lines = [""];
  const walk = (current: Node) => current.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) lines[lines.length - 1] += child.textContent ?? "";
    else if (sameCellBreak(child)) lines.push("");
    else if (child.nodeName === "BR") lines[lines.length - 1] += " ";
    else walk(child);
  });
  walk(node);
  return lines.map((line) => line.replace(whitespace, " ").replace(/^ | $/g, "").replaceAll("\u00a0", " ")).join("\n");
};
const sameBlock = (a: readonly (readonly string[])[], b: readonly (readonly string[])[]) =>
  a.length === b.length && a.every((row, r) => row.length === b[r]?.length && row.every((value, c) => value === b[r]![c]));

/** Spreadsheet HTML adds in-cell breaks; equivalent plain text keeps the caller's TSV rules. */
export function readClipboard(data: ClipboardData, parseText: (text: string) => readonly (readonly string[])[]) {
  const plain = parseText(data.getData("text/plain"));
  const table = new DOMParser().parseFromString(data.getData("text/html"), "text/html").querySelector("table");
  if (!table) return plain;
  const block = Array.from(table.rows, (row) => Array.from(row.cells, cellLines));
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
        if (index) {
          const br = document.createElement("br");
          br.setAttribute("style", "mso-data-placement:same-cell");
          td.append(br);
        }
        td.append(line);
      });
      tr.append(td);
    }
    table.append(tr);
  }
  data.setData("text/html", table.outerHTML);
}
