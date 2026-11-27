// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { ROW_SPEC, toFields, type RowDraft } from "./record-spec";

type RecordSegment = components["schemas"]["PersonRecordSectionSegment"];
type RecordImportRequest = components["schemas"]["PersonRecordImportRequest"];

export const IMPORT_SECTIONS = [
  "education",
  "qualification",
  "military",
  "language",
  "training",
  "award",
  "family",
] as const satisfies readonly RecordSegment[];

export type ImportableSection = (typeof IMPORT_SECTIONS)[number];
export type ParsedSheetRow = RecordImportRequest["rows"][number];

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

export function parseSheetText(
  section: ImportableSection,
  raw: string,
  labels: { numberCol: string; nameCol: string; voidCol: string; fieldLabel: (key: string) => string },
): ParsedSheetRow[] {
  const spec = ROW_SPEC[section] ?? [];
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const sep = lines[0]!.includes("\t") ? "\t" : ",";
  const headers = splitLine(lines[0]!, sep).map((h) => h.replace(/^'/, "").trim().toLowerCase());
  const idx = (names: readonly string[]) => headers.findIndex((h) => names.includes(h));
  const empNumIdx = idx(["employee_number", labels.numberCol.toLowerCase()]);
  const empNameIdx = idx(["employee_name", "name", labels.nameCol.toLowerCase()]);
  const entryIdIdx = idx(["entry_id"]);
  const versionIdx = idx(["expected_version", "version"]);
  const voidIdx = idx(["void_reason", labels.voidCol.toLowerCase()]);
  if (empNumIdx < 0) return [];

  const fieldIdx = spec.map((f) => ({
    key: f.key,
    col: idx([f.key.toLowerCase(), labels.fieldLabel(f.key).toLowerCase()]),
  }));

  const rows: ParsedSheetRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i]!, sep).map((c) => c.replace(/^'/, "").trim());
    const employee_number = cells[empNumIdx] ?? "";
    if (!employee_number) continue;
    const employee_name = empNameIdx >= 0 && cells[empNameIdx] ? cells[empNameIdx]! : null;
    const entry_id = entryIdIdx >= 0 && cells[entryIdIdx] ? cells[entryIdIdx]! : null;
    const versionRaw = versionIdx >= 0 && cells[versionIdx] ? Number.parseInt(cells[versionIdx]!, 10) : Number.NaN;
    const expected_version = Number.isFinite(versionRaw) ? versionRaw : null;
    const void_reason = voidIdx >= 0 && cells[voidIdx] ? cells[voidIdx]! : null;
    const draft: RowDraft = {};
    for (const f of fieldIdx) {
      if (f.col >= 0 && cells[f.col]) draft[f.key] = cells[f.col]!;
    }
    const fields = void_reason ? null : toFields(spec, draft);
    rows.push({ row: i + 1, employee_number, employee_name, entry_id, expected_version, void_reason, fields });
  }
  return rows;
}
