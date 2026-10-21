// Org sheet import, preview step (S7): the settled rows as one outline per legal entity, planned against the
// tree the same way a pasted list is (planOutline), and the row funnel (rows = applied + error + left out). Pure.
// Departments missing from the file are untouched: an import only links and creates.
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import type { SheetRow } from "./columns";
import type { OutlineRow } from "./outline";
import { sheetParents, withParents } from "./parents";
import { planOutline, type PlanRow } from "./plan";
import { rowEntity, type Pick, type ValueItem } from "./values";

/** The ref prefix that keeps one legal entity's new rows apart from another's in the shared batch. */
export const entityPrefix = (i: number) => `e${i}:`;

/** `name`: the parent (noParent) or head employee number (headUnknown) the row names that could not be placed. */
export type RowError = { line: number; kind: "noWorkplace" | "noEntity" | "noParent" | "headUnknown"; name?: string };
export type ImportPlan = {
  byEntity: { entity: Node; rows: PlanRow[] }[];
  lines: { total: number; apply: number; error: number; skipped: number };
  errors: RowError[];
};

/** `heads`: each head employee number the sheet names, resolved to its employee (null: no such person; absent: not read yet). */
export function importPlan(rows: SheetRow[], ents: Node[], items: ValueItem[], picks: Record<string, Pick>, heads: ReadonlyMap<string, string | null> = new Map()): ImportPlan {
  const byId = new Map(ents.flatMap((e) => [[e.id, { entity: e, name: e.name }], ...e.children.map((w) => [w.id, { entity: e, name: w.name }] as const)]));
  const outlines = new Map<string, { seen: Set<string>; rows: OutlineRow[] }>();
  const errors: RowError[] = [];
  const parents = sheetParents(rows);
  const nodeOf = new Map(ents.flatMap((e) => e.children.map((w) => [w.id, w] as const)));
  let skipped = 0;
  for (const r of rows) {
    let ent = rowEntity(r, ents, picks, items);
    if (ent === "skip") {
      skipped++;
      continue;
    }
    if (!r.workplace) {
      errors.push({ line: r.line, kind: "noWorkplace" });
      continue;
    }
    const item = items.find((i) => i.column === "workplace" && i.value === r.workplace && (i.entityId ?? null) === (ent ?? null));
    const pick = item ? picks[item.key] : undefined;
    if (pick?.to === "skip") {
      skipped++;
      continue;
    }
    const target = item?.match ?? (pick?.to === "id" ? pick.id : undefined);
    // A workplace settles the entity a row without one belongs to.
    if (target) ent = byId.get(target)!.entity.id;
    const site = target ? byId.get(target)!.name : pick?.to === "create" ? r.workplace : undefined;
    if (!ent || !site) {
      errors.push({ line: r.line, kind: "noEntity" });
      continue;
    }
    const path = withParents(r, parents, target ? nodeOf.get(target) : undefined);
    if (!Array.isArray(path)) {
      errors.push({ line: r.line, kind: "noParent", name: path.refused });
      continue;
    }
    if (r.head && heads.get(r.head) === null) {
      errors.push({ line: r.line, kind: "headUnknown", name: r.head });
      continue;
    }
    const o = outlines.get(ent) ?? outlines.set(ent, { seen: new Set(), rows: [] }).get(ent)!;
    [site, ...path].forEach((name, depth, all) => {
      const key = all.slice(0, depth + 1).join("\u0000");
      if (o.seen.has(key)) return;
      o.seen.add(key);
      const own = depth === all.length - 1 && depth > 0;
      o.rows.push({ line: r.line, depth, name, ...(own && r.code ? { code: r.code } : {}), ...(own && r.head ? { head: r.head } : {}) });
    });
  }
  const byEntity = ents.filter((e) => outlines.has(e.id)).map((e) => ({ entity: e, rows: planOutline({ kind: "entity", node: e }, outlines.get(e.id)!.rows) }));
  return { byEntity, errors, lines: { total: rows.length, apply: rows.length - errors.length - skipped, error: errors.length, skipped } };
}
