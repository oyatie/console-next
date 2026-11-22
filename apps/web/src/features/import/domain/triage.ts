// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ImportDryRun, ImportPreview, ImportRow } from "./contract";

export type TriageBucket = "all" | "valid" | "warn" | "blocker";

function isHardBlockerRow(row: ImportRow): boolean {
  return row.outcome === "refused" || row.outcome === "unresolved_identity";
}

function isWarningRow(row: ImportRow): boolean {
  if (isHardBlockerRow(row)) return false;
  return (
    row.outcome === "excluded" ||
    (row.deferred?.length ?? 0) > 0 ||
    Boolean(row.unit_name || row.workplace_name) ||
    (row.new_person != null && row.new_person.employee_number == null)
  );
}

function isValidRow(row: ImportRow): boolean {
  return !isHardBlockerRow(row) && !isWarningRow(row);
}

export function rowTriageBucket(row: ImportRow): Exclude<TriageBucket, "all"> {
  if (isHardBlockerRow(row)) return "blocker";
  if (isWarningRow(row)) return "warn";
  return "valid";
}

export function triageCounts(rows: readonly ImportRow[]): Record<TriageBucket, number> {
  let valid = 0;
  let warn = 0;
  let blocker = 0;
  for (const row of rows) {
    if (isHardBlockerRow(row)) blocker += 1;
    else if (isWarningRow(row)) warn += 1;
    else valid += 1;
  }
  return { all: rows.length, valid, warn, blocker };
}

export function filterTriageRows(rows: readonly ImportRow[], bucket: TriageBucket): ImportRow[] {
  if (bucket === "all") return [...rows];
  if (bucket === "blocker") return rows.filter(isHardBlockerRow);
  if (bucket === "warn") return rows.filter(isWarningRow);
  return rows.filter(isValidRow);
}

const KNOWN_HINT_CODES = new Set([
  "invalid_date",
  "hire_date_required",
  "workplace_conflict",
  "status_conflict",
  "identity_mismatch",
  "identity_conflict",
  "employee_number_taken",
  "duplicate_in_file",
  "exit_date_required",
  "leave_start_required",
  "leave_type_unmapped",
  "leave_return_required",
  "status_unmapped",
  "former_load_closed",
]);

export function rowRemediationHintKey(row: ImportRow): string | null {
  if (row.outcome === "unresolved_identity") return "import.hint.unresolved_identity";
  if (row.outcome === "refused" && row.refusal_code && KNOWN_HINT_CODES.has(row.refusal_code)) {
    return `import.hint.${row.refusal_code}`;
  }
  return null;
}

export function itemRemediationHintKey(reason: string): string | null {
  if (reason === "unresolved_identity") return "import.hint.unresolved_identity";
  return KNOWN_HINT_CODES.has(reason) ? `import.hint.${reason}` : null;
}

export function hasMappedSexColumn(preview: Pick<ImportPreview, "columns"> | null | undefined): boolean {
  return Boolean(preview?.columns.some((col) => col.target === "sex"));
}

export function firstActionableRowKey(dry: Pick<ImportDryRun, "rows">): string | null {
  return (
    dry.rows.find(isHardBlockerRow)?.source_key ??
    dry.rows.find(isWarningRow)?.source_key ??
    dry.rows[0]?.source_key ??
    null
  );
}
