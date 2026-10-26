// The work schedule scope tree (legal entity › workplace › department, crew under their workplace) as the server lists it, flat with parents.

export type ScopeKind = "LEGAL_ENTITY" | "WORKPLACE" | "DEPARTMENT" | "CREW" | "PERSON";
export type TreeNode = { kind: ScopeKind; id: string; parent_id?: string | null; workplace_id?: string | null; name: string; people: number; layer?: { pattern_name: string } | null; effective?: { pattern_name: string; from: ScopeKind } | null; unscheduled?: number };

/** Nearest level first: the order layers win in (person › crew › department › workplace › legal entity). */
export const LEVELS: readonly ScopeKind[] = ["PERSON", "CREW", "DEPARTMENT", "WORKPLACE", "LEGAL_ENTITY"];

export type Tree = { roots: TreeNode[]; childrenOf: (n: TreeNode) => TreeNode[]; byId: Map<string, TreeNode> };

/**
 * The tree, with `query` (a name, any case) keeping each matching node and its ancestors; an empty query keeps all.
 * A node whose parent is outside the caller's scope becomes a root, so nothing in scope is hidden.
 */
export function buildTree(nodes: readonly TreeNode[], query = ""): Tree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const q = query.trim().toLocaleLowerCase();
  const keep = new Set<string>();
  for (const n of nodes) {
    if (q && !n.name.toLocaleLowerCase().includes(q)) continue;
    for (let at: TreeNode | undefined = n; at && !keep.has(at.id); at = at.parent_id ? byId.get(at.parent_id) : undefined) keep.add(at.id);
  }
  const kids = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  for (const n of nodes) {
    if (!keep.has(n.id)) continue;
    const parent = n.parent_id && keep.has(n.parent_id) ? n.parent_id : null;
    if (parent) kids.set(parent, [...(kids.get(parent) ?? []), n]);
    else roots.push(n);
  }
  return { roots, childrenOf: (n) => kids.get(n.id) ?? [], byId };
}

/** Ids from the root down to `id`, so the tree can open the way to a chosen node. */
export function pathTo(byId: Map<string, TreeNode>, id: string): string[] {
  const out: string[] = [];
  for (let at = byId.get(id); at; at = at.parent_id ? byId.get(at.parent_id) : undefined) out.unshift(at.id);
  return out;
}
