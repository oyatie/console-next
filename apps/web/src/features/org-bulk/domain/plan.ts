// Outline rows → what a commit would make under one legal entity or one workplace (S7 paste, the import's tree). Pure.
//
// Level follows position (decisions #18): under a legal entity the first level is workplace and every deeper one is a department;
// under a workplace every level is a department. A row whose exact name (nameKey) already stands at that place links to
// it; nothing is matched by similarity. Two rows that would make the same name under one parent are a clash
// the user renames in place.
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { nameKey, type OutlineRow } from "./outline";

export type PlanRoot = { kind: "entity"; node: Node } | { kind: "workplace"; node: Node };
export type PlanStatus = "link" | "create" | "clash" | "tooDeep" | "kind_not_allowed";
export type PlanRow = OutlineRow & {
  level: "workplace" | "dept";
  status: PlanStatus;
  /** link: the existing node. */
  existing?: Node;
  /** This row's place in the plan (rows keep their order); clash renames are keyed by it. */
  at: number;
  /** The row this one sits under (its `at`), or undefined at the first level. */
  parent?: number;
};

const units = (n: Node | undefined) => (n?.children ?? []).filter((c) => c.kind === "DEPARTMENT");
const workplaces = (n: Node) => n.children.filter((c) => c.kind === "WORKPLACE");

/** `names` renames rows (by `at`) before the plan is drawn again. */
export function planOutline(root: PlanRoot, rows: OutlineRow[], names: Record<number, string> = {}): PlanRow[] {
  const out: PlanRow[] = [];
  const stack: PlanRow[] = [];
  // Names already taken under each parent: "root" or the parent row's `at`.
  const taken = new Map<string, Set<string>>();
  rows.forEach((r, at) => {
    const name = nameKey(names[at] ?? r.name);
    const parent = stack[r.depth - 1];
    if (r.depth > 0 && !parent) {
      out.push({ ...r, at, name, level: "dept", status: "tooDeep" });
      return;
    }
    stack.length = r.depth;
    const level = root.kind === "entity" && r.depth === 0 ? "workplace" : "dept";
    const parentNode = parent ? parent.existing : root.node;
    const siblings = level === "workplace" ? workplaces(root.node) : units(parentNode);
    const existing = siblings.find((n) => nameKey(n.name) === name);
    const key = parent ? String(parent.at) : "root";
    const used = taken.get(key) ?? taken.set(key, new Set()).get(key)!;
    const status: PlanStatus = r.kind && level === "dept" ? "kind_not_allowed" : used.has(name) ? "clash" : existing ? "link" : "create";
    used.add(name);
    const row: PlanRow = { ...r, at, name, level, status, ...(status === "link" ? { existing } : {}), ...(parent ? { parent: parent.at } : {}) };
    out.push(row);
    stack[r.depth] = row;
  });
  return out;
}

/** Counts the screen states: new workplace, new department, links and clashes. */
export function planCounts(rows: PlanRow[]) {
  const n = (f: (r: PlanRow) => boolean) => rows.filter(f).length;
  return {
    workplaces: n((r) => r.status === "create" && r.level === "workplace"),
    depts: n((r) => r.status === "create" && r.level === "dept"),
    links: n((r) => r.status === "link"),
    fix: n((r) => r.status !== "link" && r.status !== "create"),
  };
}
