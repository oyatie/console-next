import { entityGaps } from "./create";
import type { BizKind, RepresentationMode } from "@console/api/pending";
import { emptyDraft, type Draft } from "./draft";

export const BULK_FIELDS = ["name", "kind", "representatives", "mode", "crn", "road", "zip"] as const;
export type BulkField = typeof BULK_FIELDS[number];
export type BulkColumns = Record<BulkField, number>;
export type EntityRow = { line: number; draft: Draft; modeUnrecognized?: boolean };
export const emptyColumns = (): BulkColumns => ({ name: -1, kind: -1, representatives: -1, mode: -1, crn: -1, road: -1, zip: -1 });

/** Only exact header matches; the operator chooses unknown columns before preview. */
export function guessEntityColumns(headers: string[], words: Record<BulkField, string>): BulkColumns {
  const columns = emptyColumns();
  for (const field of BULK_FIELDS) columns[field] = headers.findIndex((h) => h.trim().toLocaleLowerCase() === words[field].toLocaleLowerCase());
  return columns;
}

/** Named source values become typed drafts; unknown kinds and representation modes stay unanswered. */
export function entityRows(grid: string[][], header: number, columns: BulkColumns, kinds: Record<BizKind, string>, modes: Record<RepresentationMode, string>): EntityRow[] {
  return grid.slice(header + 1).flatMap((row, i) => {
    if (!row.some((v) => v.trim())) return [];
    const get = (field: BulkField) => (row[columns[field]] ?? "").trim();
    const kind = (Object.keys(kinds) as BizKind[]).find((k) => k === get("kind") || kinds[k] === get("kind")) ?? null;
    const mode = (Object.keys(modes) as RepresentationMode[]).find((m) => m === get("mode") || modes[m] === get("mode")) ?? null;
    return [{ line: header + i + 2, modeUnrecognized: Boolean(get("mode")) && mode === null, draft: { ...emptyDraft(), name: get("name"), bizKind: kind,
      representatives: get("representatives").split("|").map((n) => n.trim()).filter(Boolean),
      representationMode: mode, crn: get("crn").replace(/[- ]/g, ""), headOffice: "OTHER",
      headOfficeAddress: get("road") ? { road: get("road"), zip: get("zip"), detail: "", verified: false } : null,
    } }];
  });
}

/** Imported legal facts cannot be silently replaced by the single-representative inference. */
export function bulkGaps(row: EntityRow) {
  const gaps = entityGaps(row.draft);
  const count = row.draft.representatives.filter((n) => n.trim()).length;
  const mode = row.draft.representationMode;
  if (!gaps.includes("representationMode") && ((row.modeUnrecognized && !mode) || (count === 1 && mode && mode !== "SINGLE") || (count > 1 && mode === "SINGLE"))) gaps.push("representationMode");
  return gaps;
}
