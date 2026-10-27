// SPDX-License-Identifier: LicenseRef-Proprietary
/** An unmatched quote or a quoted word followed by text is literal paste content. */
function quotedCellEnd(text: string, start: number, separators: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== '"') continue;
    if (text[i + 1] === '"') i++;
    else {
      const next = text[i + 1];
      return next === undefined || separators.includes(next) || next === "\r" || next === "\n" ? i : -1;
    }
  }
  return -1;
}

/** Mixed appointment pastes prefer an unquoted tab, otherwise a comma, per logical record. */
function recordDelimiter(text: string, start: number): "\t" | "," {
  let quoted = false, cellStart = true;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"' && cellStart && quotedCellEnd(text, i, "\t,") >= 0) quoted = true;
    else if (ch === "\t") return "\t";
    else if (ch === "\r" || ch === "\n") break;
    cellStart = !quoted && ch === ",";
  }
  return ",";
}

/** CSV or TSV text with complete RFC 4180 quoted cells; other quotes stay literal. A caller may fix the delimiter or preserve mixed appointment rows. */
export function readDelimited(text: string, { delimiter }: { delimiter?: "\t" | "," | "mixed" } = {}): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const detected = (first.match(/\t/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? "\t" : ",";
  let sep = delimiter === "mixed" ? recordDelimiter(text, 0) : delimiter ?? detected;
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "" && quotedCellEnd(text, i, sep) >= 0) quoted = true;
    else if (ch === sep) endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (delimiter === "mixed") sep = recordDelimiter(text, i + 1);
    } else cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}
