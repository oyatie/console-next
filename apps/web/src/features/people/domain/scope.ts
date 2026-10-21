// The roster's scope (E1-scope): everyone, one legal entity, one workplace, or one department with everything under it. It travels in the
// `unit` search param: "le:<id>" a legal entity, "wp:<id>" a workplace, a bare id a department — so links and Back keep it.

type Unit = { id: string; kind: string; name: string; parentId: string | null; status: string; headcount: number };
type Entity = { id: string; name: string; workplaces: { id: string; name: string; orgUnitId?: string | null }[] };
type Count = { value: string | null; count: number };

/** The list filter a scope asks the server for. */
export function scopeQuery(unit: string | undefined): { legal_entity_id?: string; workplace_id?: string; org_unit_id?: string } {
  if (!unit) return {};
  if (unit.startsWith("le:")) return { legal_entity_id: unit.slice(3) };
  if (unit.startsWith("wp:")) return { workplace_id: unit.slice(3) };
  return { org_unit_id: unit };
}

export type ScopeRow = { value: string; name: string; depth: 0 | 1 | 2 | 3; count?: number; meta?: { sites?: number; units?: number } };

/** A department's members with everything under it (each unit's headcount is its own members only). */
export function rolledUp(units: readonly Unit[], id: string): number {
  const own = units.find((u) => u.id === id)?.headcount ?? 0;
  return own + units.filter((u) => u.parentId === id && u.status !== "DISSOLVED").reduce((n, u) => n + rolledUp(units, u.id), 0);
}

/**
 * The tree the picker shows, filtered by `q` (a match keeps its ancestors). legal entity and workplace count from the facets read;
 * a workplace's departments are the units under its bound SITE unit, counted with everything under them.
 */
export function scopeRows(entities: readonly Entity[], units: readonly Unit[], byEntity: readonly Count[], bySite: readonly Count[], q = ""): ScopeRow[] {
  const live = units.filter((u) => u.status !== "DISSOLVED");
  const count = (rows: readonly Count[], id: string) => rows.find((r) => r.value === id)?.count ?? 0;
  const under = (id: string, depth: 2 | 3): ScopeRow[] =>
    live.filter((u) => u.parentId === id).flatMap((u) => [{ value: u.id, name: u.name, depth, count: rolledUp(live, u.id) }, ...(depth === 2 ? under(u.id, 3) : [])]);
  const hit = (name: string) => !q || name.toLowerCase().includes(q.trim().toLowerCase());
  return entities.flatMap((e) => {
    const sites = e.workplaces.map((w) => {
      const site = live.find((u) => u.id === w.orgUnitId);
      const depts = site ? under(site.id, 2) : [];
      const shown = hit(w.name) || hit(e.name) ? depts : depts.filter((d) => hit(d.name));
      return { row: { value: `wp:${w.id}`, name: w.name, depth: 1 as const, count: count(bySite, w.id) }, depts: shown, keep: hit(w.name) || hit(e.name) || shown.length > 0 };
    });
    const kept = sites.filter((x) => x.keep);
    if (!hit(e.name) && kept.length === 0) return [];
    const deptCount = sites.reduce((n, x) => n + x.depts.length, 0);
    return [{ value: `le:${e.id}`, name: e.name, depth: 0 as const, count: count(byEntity, e.id), meta: { sites: e.workplaces.length, units: deptCount } }, ...kept.flatMap((x) => [x.row, ...x.depts])];
  });
}
