// Where a unit stands now, read from a fresh org structure tree (S11 stale move): its ancestors from the legal
// entity down, and its served version. Pure.
type Node = { id: string; name: string; version?: number; children: readonly Node[] };

/** The names from the legal entity down to the unit's parent, and the unit itself; undefined once it is gone. */
export function unitPath(roots: readonly Node[], id: string): { path: string[]; node: Node } | undefined {
  const walk = (ns: readonly Node[], above: string[]): { path: string[]; node: Node } | undefined => {
    for (const n of ns) {
      if (n.id === id) return { path: above, node: n };
      const hit = walk(n.children, [...above, n.name]);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(roots, []);
}
