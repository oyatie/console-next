// Outline paste (MR-30, spec S7 *Paste* shape for one place): lines indented by tabs (or 2 spaces, or a leading
// "-"/"*") become nested departments under one parent, in row order, as one batch with refs. Pure.
import type { components } from "@console/api/schema";

type SetupOp = components["schemas"]["OrgSetupOp"];
export type PastedLine = { name: string; depth: number; line: number };
export type PasteProblem = { line: number; code: "tooDeep" | "duplicate" | "tooLong" };

const MAX_NAME = 120;

/** The lines with their depth (0 = directly under the parent); blank lines are skipped. */
export function parseOutline(text: string): PastedLine[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw, i) => {
      const lead = raw.match(/^[\t ]*/)![0];
      const depth = [...lead].reduce((d, ch) => d + (ch === "\t" ? 2 : 1), 0) >> 1;
      return { name: raw.trim().replace(/^[-*·•]\s*/, "").split("\t")[0]!.trim(), depth, line: i + 1 };
    })
    .filter((l) => l.name);
}

/** What stops the paste: a line deeper than one below the line before it, a repeated sibling, a name too long. */
export function pasteProblems(lines: readonly PastedLine[], existing: ReadonlySet<string>): PasteProblem[] {
  const out: PasteProblem[] = [];
  // scope[d]: the names already used under the current parent at depth d.
  const scope: Set<string>[] = [];
  let prev = -1;
  for (const l of lines) {
    if (l.depth > prev + 1) out.push({ line: l.line, code: "tooDeep" });
    if (l.name.length > MAX_NAME) out.push({ line: l.line, code: "tooLong" });
    scope.length = Math.min(scope.length, l.depth + 1);
    const names = (scope[l.depth] ??= new Set(l.depth === 0 ? [...existing].map((n) => n.normalize("NFC")) : []));
    const key = l.name.normalize("NFC");
    if (names.has(key)) out.push({ line: l.line, code: "duplicate" });
    names.add(key);
    prev = l.depth;
  }
  return out;
}

/** One CREATE per line: depth 0 under `parent`, deeper lines under the nearest line above with one less depth. */
export function pasteOps(lines: readonly PastedLine[], parent: { workplace_id: string } | { parent_org_unit_id: string }): SetupOp[] {
  const stack: string[] = [];
  return lines.map((l, i) => {
    const ref = `p${i}`;
    stack.length = l.depth;
    const up = stack[l.depth - 1];
    stack[l.depth] = ref;
    return { op: "CREATE", ref, name: l.name, ...(up ? { parent_ref: up } : parent) };
  });
}
