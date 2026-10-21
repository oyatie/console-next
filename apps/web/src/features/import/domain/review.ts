// The served needs-review queue (IMPORT-2): what each item asks for, so the screen offers exactly the control that
// answers it. The server builds the queue; nothing here decides whether an item blocks.
import type { ImportDryRun, ReviewItem } from "./contract";
import { answerOf, type Picks } from "./steps";

/**
 * The control an item needs: served `choices` to click, a person to pick (namesakes), a reason to leave a row out, a
 * unit / workplace / employment type to pick, a employee number to type, the sheet's columns to map, or nothing (said, not asked).
 */
export type ResolveKind = "choices" | "identity" | "exclude" | "company" | "unit" | "workplace" | "type" | "number" | "mapping" | "info";

export function resolveKind(i: ReviewItem): ResolveKind {
  const r = i.resolution;
  if (!r) return "info";
  switch (r.decision) {
    case "identity": return "identity";
    case "exclusions": return "exclude";
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

/** The planned row an item is about: named by source key (identity, refusal, employee number), else by its sheet and row. */
export const rowOf = (d: ImportDryRun, i: ReviewItem) =>
  d.rows.find((r) => r.source_key === i.resolution?.key) ?? (i.row != null ? d.rows.find((r) => r.sheet === i.sheet && r.row === i.row) : undefined);

/** Where the item is in the file: the sheet and the cell (or row) the operator can find it at. */
export const placeOf = (i: ReviewItem) => ({ sheet: i.sheet, cell: i.cell ?? (i.row != null ? String(i.row) : "") });

/** The answer the screen holds for the item and the next dry run will carry (null: not answered yet). */
export const heldAnswer = (c: Picks, i: ReviewItem) => (i.resolution ? answerOf(c, i.resolution.decision, i.resolution.key) : null);

export type QueueFilter = "all" | "blocking";
export const filterQueue = (items: ReviewItem[], f: QueueFilter) => (f === "blocking" ? items.filter((i) => i.blocking) : items);

