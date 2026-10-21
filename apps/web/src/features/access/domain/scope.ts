// The scope of a grant (design §2.5, contract AccessScope): whole company, or one entity / workplace / department with or without the units
// below. The tree comes from GET /org-structure (headcounts rolled up to each node). Which kinds the server enforces
// now comes from the catalog's scope_kinds (AX-5: TENANT, LEGAL_ENTITY, WORKPLACE and a DEPARTMENT subtree, always with
// the units below).

export type OrgKind = "LEGAL_ENTITY" | "WORKPLACE" | "SITE" | "DEPARTMENT" | "TEAM";
export type OrgNode = { kind: OrgKind; id: string; name: string; headcount: number; children: OrgNode[]; chips?: readonly string[] };
export type ScopeKind = "TENANT" | "LEGAL_ENTITY" | "WORKPLACE" | "DEPARTMENT";
export type Scope = { kind: ScopeKind; node_id?: string | null; include_descendants: boolean };
export type KindRule = { kind: ScopeKind; enforceable: boolean; descendants_only: boolean };

/** The scope kind a tree node is granted as: a SITE is a workplace's own unit and a TEAM is a deeper department. */
export const scopeKind = (k: OrgKind): ScopeKind => (k === "LEGAL_ENTITY" ? "LEGAL_ENTITY" : k === "WORKPLACE" ? "WORKPLACE" : "DEPARTMENT");

/** A tree row for the picker: the node, its depth (1 = entity), and the names and ids of the nodes above it. */
export type Row = { node: OrgNode; depth: number; path: string[]; above: string[] };

/** Every node of the tree, depth-first in display order. */
export function flatten(roots: readonly OrgNode[]): Row[] {
  const out: Row[] = [];
  const walk = (n: OrgNode, depth: number, path: string[], above: string[]) => {
    out.push({ node: n, depth, path, above });
    n.children.forEach((c) => walk(c, depth + 1, [...path, n.name], [...above, n.id]));
  };
  roots.forEach((r) => walk(r, 1, [], []));
  return out;
}

export const find = (roots: readonly OrgNode[], id: string) => flatten(roots).find((r) => r.node.id === id);

/**
 * The tree cut to the nodes a grant can name: a kind the server does not enforce is never offered, and neither is a
 * closed entity or workplace (company-21: the server refuses it, scope_node_closed) or anything under it — the cut stops there.
 */
export function offered(roots: readonly OrgNode[], rules: readonly KindRule[]): OrgNode[] {
  const ok = (n: OrgNode) => rules.find((r) => r.kind === scopeKind(n.kind))?.enforceable === true && !n.chips?.includes("closed");
  const cut = (n: OrgNode): OrgNode => ({ ...n, children: n.children.filter(ok).map(cut) });
  return roots.filter(ok).map(cut);
}

/** A node as a scope, with the units below (the only form the pilot enforces; 「this unit only」 comes with the door re-key). */
export const nodeScope = (n: OrgNode): Scope => ({ kind: scopeKind(n.kind), node_id: n.id, include_descendants: true });

/** People a scope reaches now: the tenant total, the node's rolled-up count, or the node's own count without units below. */
export function reach(roots: readonly OrgNode[], s: Scope): number | null {
  if (s.kind === "TENANT") return roots.reduce((a, r) => a + r.headcount, 0);
  const row = s.node_id ? find(roots, s.node_id) : undefined;
  if (!row) return null;
  return s.include_descendants ? row.node.headcount : row.node.headcount - row.node.children.reduce((a, c) => a + c.headcount, 0);
}

/** Two scopes name the same records (the same role twice over one scope is refused as an overlap). */
export const sameScope = (a: Scope, b: Scope) => a.kind === b.kind && (a.node_id ?? null) === (b.node_id ?? null) && a.include_descendants === b.include_descendants;

/** Search above this many nodes (design §9.2). */
export const SEARCH_FROM = 15;

/** Rows matching a query, with the ancestors that lead to them kept so each hit reads in place. */
export function filterRows(rows: readonly Row[], q: string): Row[] {
  const term = q.trim().toLowerCase();
  if (!term) return [...rows];
  const keep = new Set<string>();
  for (const r of rows) if (r.node.name.toLowerCase().includes(term)) [...r.above, r.node.id].forEach((id) => keep.add(id));
  return rows.filter((r) => keep.has(r.node.id));
}
