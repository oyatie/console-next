// Pasted text → outline rows (S7 paste a list). Pure.
//
// Three shapes are read, and the shape found is reported so the screen can say what it understood:
// - indent: leading tabs (an Excel copy puts each level in its own column, which arrives as tabs) or spaces;
// - path: one line per leaf, levels joined by ">" or "›" ("Production > Team 1"); "/" stays part of a name ("A/S team");
// - a cell after the name (tab-separated) is a workplace type label on the first level.

/** `code` and `head` (a employee number) ride on the row that names the unit itself (org-06 import). */
export type OutlineRow = { line: number; depth: number; name: string; kind?: string; code?: string; head?: string };
export type OutlineShape = { by: "indent" | "path"; depth: number; kindColumn: boolean };

/** One name as it is compared everywhere: NFC, outer whitespace dropped. Nothing else is folded (no fuzzy match). */
export const nameKey = (s: string) => s.normalize("NFC").trim();

const PATH_SEP = /\s*[>›]\s*/;

/** Leading indent in levels: each tab is one level; space widths count by their rank (2·6·10 spaces read as 0·1·2). */
function indents(lines: string[]): number[] {
  const lead = lines.map((l) => {
    const tabs = /^\t*/.exec(l)![0].length;
    return { tabs, spaces: /^ */.exec(l.slice(tabs))![0].length };
  });
  const widths = [...new Set([0, ...lead.map((x) => x.spaces)])].sort((a, b) => a - b);
  return lead.map((x) => x.tabs + widths.indexOf(x.spaces));
}

export function parseOutline(text: string): { rows: OutlineRow[]; shape: OutlineShape } {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const kept = raw.map((l, i) => ({ l, line: i + 1 })).filter((x) => x.l.trim() !== "");
  const byPath = kept.some((x) => PATH_SEP.test(x.l.trim().split("\t")[0]!));
  const rows: OutlineRow[] = [];
  if (byPath) {
    // Each line is a full path; shared prefixes become one row, in first-seen order.
    const seen = new Set<string>();
    for (const { l, line } of kept) {
      const [path = "", kind] = l.trim().split("\t");
      const parts = path.split(PATH_SEP).map(nameKey).filter(Boolean);
      parts.forEach((name, depth) => {
        const key = parts.slice(0, depth + 1).join("\u0000");
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ line, depth, name, ...(depth === 0 && kind?.trim() ? { kind: nameKey(kind) } : {}) });
      });
    }
  } else {
    const depths = indents(kept.map((x) => x.l));
    kept.forEach(({ l, line }, i) => {
      const cells = l.trim().split("\t").map(nameKey).filter(Boolean);
      const [name = "", kind] = cells;
      rows.push({ line, depth: depths[i]!, name, ...(kind ? { kind } : {}) });
    });
    // The shallowest line is level 0, whatever it was indented by.
    const base = Math.min(...rows.map((r) => r.depth));
    rows.forEach((r) => (r.depth -= base));
  }
  return {
    rows,
    shape: { by: byPath ? "path" : "indent", depth: rows.length ? Math.max(...rows.map((r) => r.depth)) + 1 : 0, kindColumn: rows.some((r) => r.kind) },
  };
}
