// One dissolution after go-live (org-06, org-31): its sub-department go up one level, its members go where they are sent (everyone to
// one place by default, any one of them elsewhere), the grants scoped to it are re-pointed or ended on the same effective date,
// and it closes — all one change. Pure: the sheet draws it, the server applies the ops in this order.
import type { components } from "@console/api/schema";
import { depts, unitIdOf, type Node, type Place } from "../../../reference/org/domain/structure";
import type { GovOp } from "./structure-plans";

type Grant = components["schemas"]["AccessGrant"];
type GrantOp = components["schemas"]["AccessGrantOperation"];
export type Member = { employeeId: string; name: string };
export type GrantChoice = "rescope" | "end";
export type Group = { to: Node; people: Member[] };

/** Where the members go when nobody chose: the parent department, or the workplace itself (workplace direct) under a top department. */
export const defaultDestination = (p: Place): Node => p.parent ?? p.workplace!;

/** The grants scoped to exactly this department (live ones; the list read only returns those). */
export const scopedGrants = (grants: readonly Grant[], unit: string) => grants.filter((g) => g.scope.kind === "DEPARTMENT" && g.scope.node_id === unit);

/** 00:00 KST of `date`: when a scheduled change's grants end and begin. */
const kstStart = (date: string) => `${date}T00:00:00+09:00`;

export function dissolvePlan(a: {
  place: Place;
  members: readonly Member[];
  to: Node;
  overrides: ReadonlyMap<string, Node>;
  grants: readonly Grant[];
  choices: ReadonlyMap<string, GrantChoice>;
  company: string;
  date: string;
  today: string;
  /** The workplace id a destination sits at (for the relocation count). */
  workplaceOf: (n: Node) => string | undefined;
}) {
  const d = a.place.node;
  const groups = new Map<string, Group>();
  for (const m of a.members) {
    const to = a.overrides.get(m.employeeId) ?? a.to;
    const g = groups.get(to.id) ?? { to, people: [] };
    g.people.push(m);
    groups.set(to.id, g);
  }
  const list = [...groups.values()];
  const single = list.length === 1;
  const ops: GovOp[] = [
    ...depts(d).map((c): GovOp => ({ op: "MOVE_ORG_UNIT", orgUnitId: c.id, parentId: unitIdOf(a.place.parent!) })),
    ...list.map((g): GovOp => ({
      op: "REASSIGN_ORG_UNIT",
      fromOrgUnit: d.id,
      toOrgUnit: unitIdOf(g.to),
      scope: { company: a.company },
      // Everyone to one place moves every member (the server's count, whoever this read missed); else by name.
      ...(single ? {} : { employeeIds: g.people.map((p) => p.employeeId) }),
    })),
    { op: "DISSOLVE_ORG_UNIT", orgUnitId: d.id },
  ];
  const later = a.date > a.today;
  const end = (g: Grant): GrantOp => (later ? { op: "set_end", grant_id: g.id, valid_to: kstStart(a.date) } : { op: "revoke", grant_id: g.id });
  const toScope = a.to.kind === "WORKPLACE" ? ({ kind: "WORKPLACE", node_id: a.to.id } as const) : ({ kind: "DEPARTMENT", node_id: a.to.id } as const);
  const grantOps: GrantOp[] = a.grants.flatMap((g): GrantOp[] => {
    const choice = a.choices.get(g.id);
    if (!choice) return [];
    if (choice === "end") return [end(g)];
    return [
      end(g),
      { op: "grant", account_id: g.account_id, role_id: g.role_id, scope: { ...toScope, include_descendants: g.scope.include_descendants }, ...(later ? { valid_from: kstStart(a.date) } : {}), valid_to: null, effective_in_setup: false },
    ];
  });
  const sitesMoved = list.reduce((n, g) => n + (a.workplaceOf(g.to) === a.place.workplace!.id ? 0 : g.people.length), 0);
  return {
    groups: list,
    ops,
    grantOps,
    /** Grants still waiting for a re-point or end choice. */
    grantsOpen: a.grants.filter((g) => !a.choices.has(g.id)).length,
    sitesMoved,
  };
}
