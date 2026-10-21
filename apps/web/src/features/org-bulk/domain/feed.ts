// org chart change history (S9-history) from the three records the server keeps today: setup department batches (MR-12), bulk
// legal entity · workplace batches (MR-29) and governed org changes. Pure. A unified audit feed with before/after and the method is
// not served, so a row says what kind of record it is and how many units it touched, never a guessed diff.
import type { components } from "@console/api/schema";
import type { EntitySetupBatchView, OrgSetupBatchView } from "@console/api/pending";

type Change = components["schemas"]["OrgChangeSummary"];

/** Why a row cannot be undone here, each with its own words (R27). */
export type UndoBlock = "isUndo" | "undone" | "governed" | "phase";
export type FeedRow = {
  id: string;
  source: "org" | "entity" | "change";
  at: string;
  /** org/entity: APPLY or UNDO; change: the change's status. */
  kind: string;
  /** org: the units the batch wrote, by name where they still stand; entity: the record count. */
  units: string[];
  count: number;
  /** null when the record does not say who (entity batches). */
  actor: { mine: boolean; name: string | null } | null;
  change?: { code: string; label: string; effectiveDate: string };
  undo: { batchId: string } | { block: UndoBlock };
};

const blockOf = (b: { kind: string; undone_by?: string | null; undoable: boolean }): UndoBlock =>
  b.kind === "UNDO" ? "isUndo" : b.undone_by ? "undone" : "phase";

export function feedRows(input: {
  org: OrgSetupBatchView[];
  entity: EntitySetupBatchView[];
  changes: Change[];
  /** A unit's current name, when it still stands. */
  nameOf: (unitId: string) => string | undefined;
  me: string | undefined;
}): FeedRow[] {
  const rows: FeedRow[] = [
    ...input.org.map((b): FeedRow => {
      const ids = [...new Set(b.units.map((u) => u.org_unit_id))];
      return {
        id: `org:${b.id}`,
        source: "org",
        at: b.created_at,
        kind: b.kind,
        units: ids.map(input.nameOf).filter((n): n is string => Boolean(n)),
        count: ids.length,
        actor: { mine: b.actor_id === input.me, name: null },
        undo: b.undoable ? { batchId: b.id } : { block: blockOf(b) },
      };
    }),
    ...input.entity.map((b): FeedRow => ({
      id: `entity:${b.id}`,
      source: "entity",
      at: b.created_at,
      kind: b.kind,
      units: [],
      count: b.records,
      actor: null,
      undo: b.undoable ? { batchId: b.id } : { block: blockOf(b) },
    })),
    ...input.changes.map((c): FeedRow => ({
      id: `change:${c.id}`,
      source: "change",
      at: c.createdAt,
      kind: c.status,
      units: [c.target.label],
      count: c.headcount,
      actor: { mine: c.draftedBy === input.me, name: c.draftedByName },
      change: { code: c.code, label: c.target.label, effectiveDate: c.effectiveDate },
      undo: { block: "governed" },
    })),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** Approved changes dated after today: the "scheduled changes" banner, nearest first. */
export function scheduled(changes: Change[], today: string): Change[] {
  return changes.filter((c) => c.status === "APPROVED" && c.effectiveDate > today).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

/** Every unit id → its current name, from the org structure tree (a workplace by its own unit too). */
export function unitNames(nodes: readonly { id: string; name: string; org_unit_id?: string; children: readonly unknown[] }[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (ns: readonly { id: string; name: string; org_unit_id?: string; children: readonly unknown[] }[]) => {
    for (const n of ns) {
      out.set(n.id, n.name);
      if (n.org_unit_id) out.set(n.org_unit_id, n.name);
      walk(n.children as typeof ns);
    }
  };
  walk(nodes);
  return out;
}
