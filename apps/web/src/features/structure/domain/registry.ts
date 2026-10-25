// The list view's rows (spec S2-registry): level, find and quick filters over the same tree, and the rows as an org
// sheet. Pure; the caller passes the words.
import { descendants, pathTo, type ChartNode, type Kind, type Structure } from "./model";
import { findHits } from "./search";

export type Level = "all" | Exclude<Kind, "tenant">;
export type ListFilter = "vacant" | "todo";
export const LIST_FILTERS: readonly ListFilter[] = ["vacant", "todo"];

const passes = (n: ChartNode, f: ReadonlySet<ListFilter>) =>
  (!f.has("vacant") || (n.kind === "dept" && !n.head)) && (!f.has("todo") || n.chips.length > 0 || (n.unplaced ?? 0) > 0);

/**
 * The rows shown: one level flat, or every level as a tree (folded rows hide their children). A find or a filter
 * keeps each matching row with the path to it, unfolded, so a hit is never shown out of place.
 */
export function registryRows(s: Structure, o: { level: Level; q: string; filters: ReadonlySet<ListFilter>; closed: ReadonlySet<string> }): ChartNode[] {
  const all = descendants(s.root);
  const hits = o.q ? new Set(findHits(s, o.q).ids) : undefined;
  const match = (n: ChartNode) => (!hits || hits.has(n.id)) && passes(n, o.filters);
  if (o.level !== "all") return all.filter((n) => n.kind === o.level && match(n));
  const narrowed = Boolean(hits || o.filters.size);
  const keep = narrowed ? new Set(all.filter(match).flatMap((n) => pathTo(s, n.id).map((p) => p.id))) : undefined;
  const out: ChartNode[] = [];
  const walk = (n: ChartNode) => {
    if (keep && !keep.has(n.id)) return;
    out.push(n);
    if (keep || !o.closed.has(n.id)) n.children.forEach(walk);
  };
  s.root.children.forEach(walk);
  return out;
}

const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/**
 * The rows as an org sheet (CSV with a BOM, so a spreadsheet reads Hangul): legal entity, workplace, the department's
 * path below the workplace, code, head and people, one row per unit. The org sheet import reads the same columns.
 */
export function registryCsv(s: Structure, rows: readonly ChartNode[], header: readonly string[], level: (n: ChartNode) => string): string {
  const lines = rows.map((n) => registryCells(s, n, level).map(cell).join(","));
  return `﻿${[header.map(cell).join(","), ...lines].join("\r\n")}\r\n`;
}

/** The same visible cells drive the list export preview and its CSV. */
export function registryCells(s: Structure, n: ChartNode, level: (n: ChartNode) => string): (string | number)[] {
  const path = pathTo(s, n.id);
  const entity = path.find((p) => p.kind === "entity")?.name ?? "";
  const site = path.find((p) => p.kind === "site")?.name ?? "";
  const depts = path.filter((p) => p.kind === "dept").map((p) => p.name).join(" > ");
  const head = n.kind === "dept" ? (n.head?.name ?? "") : n.kind === "entity" ? (n.reps?.first ?? "") : "";
  return [level(n), entity, site, depts, n.code ?? "", head, n.headcount, s.asOf, s.knownAt ?? ""];
}
