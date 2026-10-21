// Org sheet import, values step (S7, A's rule): a file value maps to a legal entity or workplace only when its
// name is exactly the same (nameKey). Everything else is a required pick with nothing preselected: an ambiguous
// value (several workplaces of that name and no entity to tell them apart), a near miss (only the spacing
// differs), or an unknown value (create, pick another, or leave its rows out). Pure.
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import type { LegalEntity } from "@console/api/pending";
import { identityProblems, primaryCertificate } from "../../../reference/entity/domain/names";
import { nameKey } from "./outline";
import type { SheetRow, SourceCell } from "./columns";

/** How a value is settled: an existing record, a new workplace, or its rows left out. */
export type Pick = { to: "id"; id: string } | { to: "create" } | { to: "skip" };
export type Problem = "unknown" | "ambiguous" | "nearMiss" | "noEntity";
/** One distinct value of a column, its rows, and either its match or what the user must decide. */
export type ValueItem = {
  key: string;
  sources?: SourceCell[];
  brn?: string;
  column: "entity" | "workplace";
  value: string;
  /** workplace: the legal entity its row names (already settled), else null. */
  entityId: string | null;
  rows: number;
  match?: string;
  problem?: Problem;
  /** ambiguous / nearMiss: the records it might mean, for the pick. */
  candidates: { id: string; name: string; entity: string }[];
};

const squash = (s: string) => s.replace(/\s+/g, "");
const sites = (ents: Node[]) => ents.flatMap((e) => e.children.filter((w) => w.kind === "WORKPLACE").map((w) => ({ id: w.id, name: w.name, entity: e.name, entityId: e.id })));

/** The legal entity values, each matched by exact name or left to pick. */
const entityKey = (r: SheetRow) => `e:${r.entity}${r.brn ? ` [${r.brn}]` : ""}`;
export function entityValues(rows: SheetRow[], ents: Node[], records: readonly LegalEntity[] = []): ValueItem[] {
  const groups = new Map<string, SheetRow[]>();
  for (const r of rows) if (r.entity || r.brn) { const key = entityKey(r); groups.set(key, [...(groups.get(key) ?? []), r]); }
  return [...groups].map(([key, grouped]) => {
    const row = grouped[0]!;
    const candidates = ents.filter((n) => {
      const record = records.find((candidate) => candidate.id === n.id);
      if (!record || record.needs_confirmation || identityProblems(record).length) return false;
      return row.brn ? primaryCertificate(record)?.brn?.value === row.brn : [record.current?.name, record.current?.display_name, record.current?.english_name].some((label) => label && nameKey(label) === row.entity);
    }).map((e) => ({ id: e.id, name: e.name, entity: e.name }));
    return { key, column: "entity", value: row.entity, brn: row.brn, entityId: null, rows: grouped.length, sources: grouped.flatMap((r) => r.entitySource ? [r.entitySource] : []), candidates, problem: candidates.length > 1 ? "ambiguous" : "unknown" };
  });
}

/** The entity a row belongs to once its entity value is settled: by match or pick; one entity when the file has none. */
export function rowEntity(r: SheetRow, ents: Node[], picks: Record<string, Pick>, items: ValueItem[]): string | null | "skip" {
  if (!r.entity && !r.brn) return ents.length === 1 ? ents[0]!.id : null;
  const item = items.find((i) => i.key === entityKey(r));
  const p = picks[entityKey(r)];
  if (p?.to === "skip") return "skip";
  return item?.match ?? (p?.to === "id" ? p.id : null);
}

/** The workplace values per (entity, value): exact match, or the problem that makes them a pick. */
export function workplaceValues(rows: SheetRow[], ents: Node[], entityOf: (r: SheetRow) => string | null | "skip"): ValueItem[] {
  const all = sites(ents);
  const groups = new Map<string, ValueItem>();
  for (const r of rows) {
    const ent = entityOf(r);
    if (ent === "skip" || !r.workplace) continue;
    const key = `w:${ent ?? ""}:${r.workplace}`;
    const g = groups.get(key);
    if (g) {
      g.rows++;
      continue;
    }
    const pool = ent ? all.filter((w) => w.entityId === ent) : all;
    const exact = pool.filter((w) => nameKey(w.name) === r.workplace);
    const near = exact.length ? [] : pool.filter((w) => squash(nameKey(w.name)) === squash(r.workplace));
    const item: ValueItem = { key, column: "workplace", value: r.workplace, entityId: ent, rows: 1, candidates: [] };
    if (exact.length === 1) item.match = exact[0]!.id;
    else if (exact.length > 1) Object.assign(item, { problem: "ambiguous", candidates: exact });
    else if (near.length) Object.assign(item, { problem: "nearMiss", candidates: near });
    else Object.assign(item, { problem: ent ? "unknown" : "noEntity" });
    groups.set(key, item);
  }
  return [...groups.values()];
}

/** The picks still open: every problem without a pick (a create is only open to a value whose entity is known). */
export const openPicks = (items: ValueItem[], picks: Record<string, Pick>) =>
  items.filter((i) => i.problem && !(picks[i.key] && (picks[i.key]!.to !== "create" || i.entityId))).length;
