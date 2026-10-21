// Search-to-focus (spec S2 *LOD and search*): every hit in tree order, counts per legal entity, and the containers a hit
// sits in (for count badges on collapsed boxes). Pure. Name, a department's code, and a registration number by its digits.
import { pathTo, type ChartNode, type Structure } from "./model";

export type Hits = { q: string; ids: string[]; perEntity: Map<string, number>; perAncestor: Map<string, number> };

const norm = (s: string) => s.normalize("NFC").toLocaleLowerCase().replace(/\s+/g, "");

export function findHits(s: Structure, q: string): Hits {
  const key = norm(q);
  // Three or more digits (hyphens ignored) also match a registration number.
  const digits = q.replace(/[\s-]/g, "");
  const byBrn = /^\d{3,}$/.test(digits);
  const out: Hits = { q, ids: [], perEntity: new Map(), perAncestor: new Map() };
  if (!key) return out;
  const walk = (n: ChartNode) => {
    if (n.kind !== "tenant" && (norm(n.name).includes(key) || (n.code && norm(n.code).includes(key)) || (byBrn && n.brnKey?.includes(digits)))) {
      out.ids.push(n.id);
      if (n.entityId) out.perEntity.set(n.entityId, (out.perEntity.get(n.entityId) ?? 0) + 1);
      for (const a of pathTo(s, n.id).slice(0, -1)) out.perAncestor.set(a.id, (out.perAncestor.get(a.id) ?? 0) + 1);
    }
    n.children.forEach(walk);
  };
  walk(s.root);
  return out;
}
