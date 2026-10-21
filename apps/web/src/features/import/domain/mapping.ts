// How the operator tells the server where a sheet's header is and what each column is (IMPORT-2 `mapping`), sent with
// the file again. Only sheets the operator edited are sent; the server detects the rest on its own.
import type { ImportSheet } from "./contract";

export type SheetMapping = { header_row?: number; columns?: Record<string, string | null>; skip?: boolean };
export type Mapping = Record<string, SheetMapping>;
/** A column of the header row the operator maps: its letter, the label in the cell, and the target chosen (null: not imported). */
export type DraftColumn = { column: string; label: string; target: string | null };
export type Draft = { header_row: number | null; columns: DraftColumn[]; skip: boolean };

/** The `mapping` form part, or nothing when every sheet is as the server read it. */
export const mappingJson = (m: Mapping) => (Object.keys(m).length ? JSON.stringify({ sheets: m }) : undefined);

/** A header row's label cells: the served columns at the detected row, else the candidate row's cells (nothing mapped yet). */
export function columnsAt(s: ImportSheet, row: number | null): DraftColumn[] {
  if (row == null) return [];
  if (row === s.header_row && s.columns?.length) return s.columns.map((c) => ({ column: c.column, label: c.label, target: c.target ?? null }));
  const cand = s.header_candidates?.find((c) => c.row === row);
  return (cand?.cells ?? []).map((c) => ({ column: c.column, label: c.label, target: null }));
}

/** The editor's starting point: the sheet as the server read it (or its likeliest header row when it read none). */
export function draftOf(s: ImportSheet): Draft {
  const row = s.header_row ?? s.header_candidates?.[0]?.row ?? null;
  return { header_row: row, columns: columnsAt(s, row), skip: s.status === "skipped" };
}

/** Moving the header row starts its columns over (another row's labels). */
export const withHeaderRow = (s: ImportSheet, d: Draft, row: number): Draft => ({ ...d, header_row: row, columns: columnsAt(s, row) });
export const withTarget = (d: Draft, column: string, target: string | null): Draft => ({
  ...d,
  columns: d.columns.map((c) => (c.column === column ? { ...c, target } : c)),
});

export type DraftProblem = "header" | "name" | "duplicate";
/** Why a draft cannot be sent yet (the server refuses the same: mapping_header_row_required, _name_required, _duplicate_target). */
export function draftProblem(d: Draft): DraftProblem | null {
  if (d.skip) return null;
  if (d.header_row == null) return "header";
  const targets = d.columns.map((c) => c.target).filter((x): x is string => x != null);
  if (!targets.includes("name")) return "name";
  if (new Set(targets).size !== targets.length) return "duplicate";
  return null;
}

/**
 * The sheet's part of `mapping`: skipped, its header row and every column's target, or (a sheet skipped before, with no
 * header read yet: r3:hire-18) read again this time, the server finding its header.
 */
export const sheetMapping = (d: Draft): SheetMapping =>
  d.skip ? { skip: true }
  : d.header_row == null ? { skip: false }
  : { header_row: d.header_row, columns: Object.fromEntries(d.columns.map((c) => [c.column, c.target])) };

/** A sheet skipped (by the operator or remembered from an earlier import) whose header was never read: un-skipping reads it. */
export const rereadsSkipped = (s: ImportSheet, d: Draft) => !d.skip && s.status === "skipped" && d.header_row == null;

/** Sheets that keep the dry run closed: no header the server could read, and not skipped. */
export const sheetsToMap = (sheets: readonly ImportSheet[]) => sheets.filter((s) => s.status === "needs_mapping");
