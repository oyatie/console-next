// Value links (spec E7-values): the dry run's value questions grouped by what they map (unit, workplace, type, status,
// leave type), one row per text in the file, the tenant's remembered answers among them. Pure.
import { IMPORT_STATUSES, LEAVE_TYPES, type ImportDryRun, type ReviewItem } from "./contract";

export const VALUE_DECISIONS = ["company_map", "unit_map", "workplace_map", "employment_type_map", "status_map", "leave_type_map"] as const;
export type ValueDecision = (typeof VALUE_DECISIONS)[number];

/** An item the value-link table answers (a text mapped to a place or a code), not the queue. */
export const isValueItem = (i: ReviewItem) => (VALUE_DECISIONS as readonly string[]).includes(i.resolution?.decision ?? "");

/** A remembered answer as an item of its own, so it opens and is answered like any other (never blocking). */
const fromMemory = (decision: ValueDecision, key: string): ReviewItem => ({
  id: `remembered:${decision}:${key}`,
  reason: "remembered",
  blocking: false,
  sheet: "",
  rows: 0,
  value: key,
  resolution: { decision, key, choices: decision === "status_map" ? [...IMPORT_STATUSES] : decision === "leave_type_map" ? [...LEAVE_TYPES] : [] },
});

/** One text of the file: its item (served, or from the tenant's memory) and whether memory answered it, or the catalog. */
export type ValueRow = { item: ReviewItem; remembered: boolean; auto?: string };
export type ValueGroup = { decision: ValueDecision; rows: ValueRow[]; open: number };

/** The groups in a fixed order, each with its served questions first (blocking first, as served) and then memory's. */
export function valueGroups(dry: ImportDryRun): ValueGroup[] {
  const served = dry.review.items.filter(isValueItem);
  return VALUE_DECISIONS.map((decision) => {
    const asked = served.filter((i) => i.resolution!.decision === decision);
    const keys = new Set(asked.map((i) => i.resolution!.key));
    const memory = dry.remembered.filter((r) => r.decision === decision && !keys.has(r.key)).map((r) => fromMemory(decision, r.key));
    // Labels the catalog mapped without asking (BE-MIG W02): listed, never silent, and overridable like any answer.
    const auto = decision === "employment_type_map" ? (dry.auto_mapped ?? []).filter((a) => !keys.has(a.value) && !memory.some((m) => m.value === a.value)) : [];
    return {
      decision,
      rows: [
        ...asked.map((item) => ({ item, remembered: false })),
        ...memory.map((item) => ({ item, remembered: true })),
        ...auto.map((a) => ({ item: { ...fromMemory(decision, a.value), id: `auto:${a.value}`, reason: "auto_mapped", rows: a.rows }, remembered: false, auto: a.code })),
      ],
      open: asked.length,
    };
  }).filter((g) => g.rows.length > 0);
}
