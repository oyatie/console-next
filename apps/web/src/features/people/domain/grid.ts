// The bulk correction grid (spec E6-grid, MR-27): which fields it edits and how, how a typed or pasted cell reads,
// and what each row amounts to. Pure.
import type { components } from "@console/api/schema";
import { manualAddress } from "../../../lib/pure/address";

type Preview = components["schemas"]["BulkEmployeeCorrectionPreview"];

/** How a column is recorded: at once (a correction), after a second person, or as a first record. */
export type GridClass = "now" | "second" | "first";
export type GridKind = "text" | "date" | "sex" | "type" | "address";
export type GridField = { key: GridKey; kind: GridKind; cls: GridClass };

export const GRID_FIELDS = [
  { key: "sex", kind: "sex", cls: "now" },
  { key: "address", kind: "address", cls: "now" },
  { key: "job", kind: "text", cls: "now" },
  { key: "name", kind: "text", cls: "now" },
  { key: "work_email", kind: "text", cls: "now" },
  { key: "register_note", kind: "text", cls: "now" },
  { key: "hire_date", kind: "date", cls: "second" },
  { key: "birth_date", kind: "date", cls: "second" },
  { key: "employee_number", kind: "text", cls: "second" },
  { key: "employment_type", kind: "type", cls: "second" },
] as const satisfies readonly { key: string; kind: GridKind; cls: GridClass }[];
export type GridKey = (typeof GRID_FIELDS)[number]["key"];
/** Fields the catalog lists but the grid never edits, with where they are changed instead (spec E6-columns). */
export const ROUTED = { org_unit: "act", worksite_name: "act", company: "act", rrn: "card", careers: "import", restricted: "none" } as const;
/** The columns a new grid starts with (spec E6-grid draws sex, address and job). */
export const DEFAULT_COLUMNS: readonly GridKey[] = ["sex", "address", "job"];

export const TYPES = ["REGULAR", "CONTRACT", "PART_TIME", "DAILY", "INTERN", "EXECUTIVE", "DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"] as const;

/** A typed cell, read: the value to send, nothing to send (blank keeps the value), or why it is not one. */
export type Cell = { send: unknown } | { keep: true } | { bad: "date" | "choice" | "address"; suggest?: string } | { bad: "server"; code: string; suggest?: undefined };

/**
 * The cells the server refused at the check (BE-EMP-UI §6): per person, each refused field's code. They stay errors in
 * the grid until typed again. A refusal of the whole row (stale record, unknown person) names no cell: the check lists it.
 */
export const refusedCells = (p: Preview): Record<string, Record<string, string>> =>
  Object.fromEntries(p.rows.filter((r) => r.outcome === "REFUSED").map((r) => [r.employee_id, Object.fromEntries((r.refusals ?? []).flatMap((x) => (x.field ? [[x.field, x.code]] : [])))]));

/**
 * Reads a typed or pasted cell. Blank keeps the current value (spec E6: a blank paste keeps); the empty-set sign clears a
 * text field. A choice is matched on its words (`words` maps each server value to how it reads).
 */
export function readCell(f: GridField, raw: string, words: Readonly<Record<string, string>>): Cell {
  const v = raw.trim();
  if (!v) return { keep: true };
  if (v === "∅") return f.kind === "text" || f.kind === "address" ? { send: null } : { bad: "choice" };
  if (f.kind === "date") {
    const m = /^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})\.?$/.exec(v.replace(/\s/g, ""));
    const iso = m ? `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}` : "";
    return m && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso) ? { send: iso } : { bad: "date" };
  }
  if (f.kind === "sex" || f.kind === "type") {
    const hit = Object.entries(words).find(([code, w]) => w === v || code === v.toUpperCase());
    if (hit) return { send: hit[0] };
    const near = Object.entries(words).find(([, w]) => w.replace(/\s/g, "").includes(v.replace(/\s/g, "")) || v.replace(/\s/g, "").includes(w.replace(/\s/g, "")));
    return { bad: "choice", suggest: near?.[1] };
  }
  if (f.kind === "address") {
    const a = manualAddress(v);
    return a ? { send: a } : { bad: "address" };
  }
  return { send: v };
}

/** How a cell's current value reads in the grid. */
export const shownValue = (f: GridField, v: unknown, words: Readonly<Record<string, string>>) =>
  v == null || v === "" ? "" : f.kind === "address" ? String((v as { road_addr_part1?: string }).road_addr_part1 ?? "") : f.kind === "sex" || f.kind === "type" ? (words[String(v)] ?? String(v)) : String(v);

/** How a value the server's check returns (text; an address as its JSON) reads in the grid. */
export function shownText(f: GridField, raw: string | null | undefined, words: Readonly<Record<string, string>>) {
  if (f.kind !== "address" || !raw) return shownValue(f, raw, words);
  try {
    return shownValue(f, JSON.parse(raw), words);
  } catch {
    return raw;
  }
}

/** Tab-separated rows as a spreadsheet copy gives them (a trailing newline is not a row). */
export const parseTsv = (text: string) => text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));

export type RowState = { changed: number; errors: number };
/** A row's status from its cells: how many differ from the record, how many are not values. */
export function rowState(cells: readonly Cell[], current: readonly string[], typed: readonly string[]): RowState {
  let changed = 0, errors = 0;
  cells.forEach((c, i) => {
    if ("bad" in c) errors++;
    else if ("send" in c && typed[i]!.trim() !== current[i]) changed++;
  });
  return { changed, errors };
}

/** Counts per column and per path from the server's preview (only fields whose value differs are listed). */
export const previewCounts = (p: Preview) => {
  const cells = p.rows.flatMap((r) => (r.outcome === "REFUSED" ? [] : r.fields));
  return { people: p.rows.filter((r) => r.outcome === "CHANGE" || r.outcome === "PENDING").length, cells: cells.length, now: cells.filter((f) => f.path !== "SECOND_PERSON").length, second: cells.filter((f) => f.path === "SECOND_PERSON").length, refused: p.rows.filter((r) => r.outcome === "REFUSED").length };
};
