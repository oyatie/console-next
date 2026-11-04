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

/** Spreadsheet HTML can add in-cell breaks; plain text retains exact whitespace when shapes agree. */
export function readClipboard(data: ClipboardData, parseText: (text: string) => readonly (readonly string[])[]) {
  const plain = parseText(data.getData("text/plain"));
  const table = new DOMParser().parseFromString(data.getData("text/html"), "text/html").querySelector("table");
  if (!table?.rows.length) return plain;
  const block: string[][] = Array.from(table.rows, () => []);
  Array.from(table.rows).forEach((row, r) => {
    let c = 0;
    for (const cell of row.cells) {
      while (block[r]![c] !== undefined) c++;
      const height = cell.rowSpan || row.parentElement!.children.length - row.sectionRowIndex;
      for (let dr = 0; dr < height && r + dr < block.length; dr++)
        for (let dc = 0; dc < cell.colSpan; dc++) block[r + dr]![c + dc] = "";
      block[r]![c] = cellLines(cell);
      c += cell.colSpan;
    }
  });
  const width = Math.max(...block.map((row) => row.length));
  const html = block.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? ""));
  if (plain.length !== html.length || plain.some((row) => row.length !== width)) return html;
  const merged = plain.map((row, r) => row.map((value, c) => {
    const formatted = html[r]![c]!;
    return formatted.split("\n").length > value.split("\n").length ? formatted : value;
  }));
  return sameBlock(merged, plain) ? plain : merged;
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
