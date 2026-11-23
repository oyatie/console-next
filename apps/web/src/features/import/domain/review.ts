// The served needs-review queue (IMPORT-2): what each item asks for, so the screen offers exactly the control that
// answers it. The server builds the queue; nothing here decides whether an item blocks.
import type { ImportDryRun, ImportRow, ReviewItem } from "./contract";
import { answerOf, type Picks } from "./steps";

/**
 * The control an item needs: served `choices` to click, a person to pick (namesakes), a reason to leave a row out,
 * inline cell repair (`cells`), a unit / workplace / employment type to pick, an employee number to type,
 * the sheet's columns to map, or nothing (said, not asked).
 */
export type ResolveKind = "choices" | "identity" | "exclude" | "cells" | "company" | "unit" | "workplace" | "type" | "number" | "mapping" | "info";

export function resolveKind(i: ReviewItem): ResolveKind {
  const r = i.resolution;
  if (!r) return "info";
  switch (r.decision) {
    case "identity": return "identity";
    case "exclusions": return "exclude";
    case "cells": return "cells";
    case "company_map": return "company";
    case "unit_map": return "unit";
    case "workplace_map": return "workplace";
    case "employment_type_map": return "type";
    case "employee_numbers": return "number";
    case "mapping": return "mapping";
    case "status_map": case "leave_type_map": return "choices";
    // Group answers are listed apart (review.groups), never as one item.
    case "group_exclusions": return "info";
  }
  return "info";
}

const RESTRICTED_REPAIR_FIELDS = new Set(["rrn", "phone", "name"]);

const isRestrictedRepairField = (field?: string | null): boolean =>
  Boolean(field && RESTRICTED_REPAIR_FIELDS.has(field));

const REPAIRABLE_EXCLUSION_REASONS = new Set([
  "invalid_date",
  "not_issued_secondary_key_required",
  "not_issued_with_rrn",
  "id_type_invalid",
  "id_type_rrn_mismatch",
  "not_issued_requires_pre_hire",
]);

/** Returns the target field for inline cell repair when safe (non-restricted), or null when not repairable inline. */
export function repairableCellField(item: ReviewItem): string | null {
  const decision = item.resolution?.decision;
  if (decision === "cells") {
    const field = item.field ?? "hire_date";
    return isRestrictedRepairField(field) ? null : field;
  }
  if (decision === "exclusions" && REPAIRABLE_EXCLUSION_REASONS.has(item.reason)) {
    const fallback =
      item.reason === "not_issued_secondary_key_required"
        ? "birth_date"
        : item.reason === "invalid_date"
          ? "hire_date"
          : "id_type";
    const field = item.field ?? fallback;
    return isRestrictedRepairField(field) ? null : field;
  }
  return null;
}

const IDENTIFIER_REASONS = new Set([
  "rrn_invalid",
  "rrn_mod11_invalid",
  "not_issued_requires_pre_hire",
  "id_type_rrn_mismatch",
]);

/** Whether an import row / review item can record a 13-digit registration identifier under PII_RECORD step-up. */
export function canRecordRowIdentifier(item: ReviewItem | undefined, row?: ImportRow): boolean {
  if (!row || row.outcome === "excluded") return false;
  if (item && IDENTIFIER_REASONS.has(item.reason)) return true;
  if (row.refusal_code && IDENTIFIER_REASONS.has(row.refusal_code)) return true;
  return row.new_person?.status === "PRE_HIRE" && row.new_person.id_type === "NOT_ISSUED";
}

/** The planned row an item is about: named by source key (identity, refusal, employee number), else by its sheet and row. */
export const rowOf = (d: ImportDryRun, i: ReviewItem) =>
  d.rows.find((r) => r.source_key === i.resolution?.key) ?? (i.row != null ? d.rows.find((r) => r.sheet === i.sheet && r.row === i.row) : undefined);

/** Where the item is in the file: the sheet and the cell (or row) the operator can find it at. */
export const placeOf = (i: ReviewItem) => ({ sheet: i.sheet, cell: i.cell ?? (i.row != null ? String(i.row) : "") });

/** The answer the screen holds for the item and the next dry run will carry (null: not answered yet). */
export const heldAnswer = (c: Picks, i: ReviewItem) => (i.resolution ? answerOf(c, i.resolution.decision, i.resolution.key) : null);

export type QueueFilter = "all" | "blocking";
export const filterQueue = (items: ReviewItem[], f: QueueFilter) => (f === "blocking" ? items.filter((i) => i.blocking) : items);

