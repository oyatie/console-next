// What deleting, merging or adding a department does, as setup ops (applied at once, undoable) and as governed ops (one
// proposal after go-live), with the before/after trees the sheets draw. Pure; tags are codes the UI words.
import type { components } from "@console/api/schema";
import type { SetupOp } from "@console/api/pending";
import type { EiUnit } from "../../../reference/entity/domain/ei-unit";
import { depts, descendants, direct, parentRef, unitIdOf, type Node, type Place } from "../../../reference/org/domain/structure";

export type GovOp = components["schemas"]["OrgProposalOp"];
/** A change mark on a drawn box; colour is only the secondary cue (D16). */
export type Tag = "gone" | "raised" | "movedIn" | "carried" | "merged" | "renamed" | "movedRenamed" | "new";
export type View = { id: string; name: string; n: number; tag?: Tag; extra?: number; children: View[] };

/** A node and the department under it, `depth` levels down (0 = the node alone). */
export const viewOf = (n: Node, depth = 99): View => ({ id: n.id, name: n.name, n: n.headcount, children: depth > 0 ? depts(n).map((c) => viewOf(c, depth - 1)) : [] });


export type ChildrenChoice = "raise" | "cascade";
export type MembersChoice = "siteDirect" | "otherDept" | "unplaced";

/**
 * Deleting a department in setup. `raise` moves its department one level up first; `cascade` dissolves them with it. The people
 * who must go somewhere are its direct members, plus everyone below when cascading.
 */
export function deletePlan(p: Place, children: ChildrenChoice | null) {
  const d = p.node;
  const parent = p.parent!;
  const sub = depts(d);
  const asked = { children: sub.length > 0, members: 0 };
  const chosen = sub.length === 0 ? "cascade" : children;
  asked.members = chosen === "cascade" ? d.headcount : chosen === "raise" ? direct(d) : direct(d);
  const ops: SetupOp[] =
    chosen === "raise"
      ? [...sub.map((c): SetupOp => ({ op: "MOVE", org_unit_id: c.id, expected_version: c.version, ...parentRef(parent) })), { op: "DISSOLVE", org_unit_id: d.id, expected_version: d.version }]
      : [{ op: "DISSOLVE", org_unit_id: d.id, expected_version: d.version }];
  const around = (tag?: (c: Node) => View[]) => ({
    ...viewOf(parent, 0),
    children: depts(parent).flatMap((c) => (c.id === d.id ? (tag ? tag(c) : []) : [viewOf(c, 0)])),
  });
  const before = around((c) => [{ ...viewOf(c, 1), tag: "gone" }]);
  const after = chosen === null ? undefined : around((c) => (chosen === "raise" ? depts(c).map((x) => ({ ...viewOf(x, 0), tag: "raised" as const })) : []));
  return { ops, asked, before, after, raised: chosen === "raise" ? sub : [] };
}

/**
 * Merging department `a` into `target` (same legal entity): its department move under the target, its direct members join the target,
 * and `a` is dissolved. Counts are exact from the tree; employment insurance changes only across reporting units.
 */
export function mergePlan(a: Place, target: Place, ei: EiUnit, company: string) {
  const sub = depts(a.node);
  const from = a.workplace!.id;
  const to = target.workplace!.id;
  const totals = {
    children: sub.length,
    members: a.node.headcount,
    siteChanged: from === to ? 0 : a.node.headcount,
    eiChanged: ei(from) === ei(to) ? 0 : a.node.headcount,
  };
  const setupOps: SetupOp[] = [
    ...sub.map((c): SetupOp => ({ op: "MOVE", org_unit_id: c.id, expected_version: c.version, ...parentRef(target.node) })),
    { op: "DISSOLVE", org_unit_id: a.node.id, expected_version: a.node.version },
  ];
  // One change (org-07): its sub-units and members move to the target, then it closes with the target as its
  // successor (kept on its record; history and grants follow it).
  const govOps: GovOp[] = [
    ...sub.map((c): GovOp => ({ op: "MOVE_ORG_UNIT", orgUnitId: c.id, parentId: unitIdOf(target.node) })),
    ...(direct(a.node) > 0 ? [{ op: "REASSIGN_ORG_UNIT", fromOrgUnit: a.node.id, toOrgUnit: target.node.id, scope: { company } } as GovOp] : []),
    { op: "DISSOLVE_ORG_UNIT", orgUnitId: a.node.id, mergedInto: target.node.id },
  ];
  const wp = target.workplace!;
  const after: View = {
    ...viewOf(wp, 0),
    n: wp.headcount + totals.siteChanged,
    children: depts(wp)
      .filter((c) => c.id !== a.node.id)
      .map((c) => (leadsTo(c, target.node.id) ? mergedInto(c, target.node, a.node) : viewOf(c, 0))),
  };
  if (target.node.kind === "WORKPLACE") after.children.push(...sub.map((c) => ({ ...viewOf(c, 0), tag: "movedIn" as const })));
  return { setupOps, govOps, totals, after, routed: direct(a.node) };
}

const leadsTo = (c: Node, id: string) => c.id === id || descendants(c).some((x) => x.id === id);
/** `c` with only the branch down to `target`, where `a`'s department and people arrive. */
function mergedInto(c: Node, target: Node, a: Node): View {
  if (c.id === target.id) return { ...viewOf(c, 0), n: c.headcount + a.headcount, tag: "merged", extra: a.headcount, children: depts(a).map((x) => ({ ...viewOf(x, 0), tag: "movedIn" as const })) };
  return { ...viewOf(c, 0), children: depts(c).filter((x) => leadsTo(x, target.id)).map((x) => mergedInto(x, target, a)) };
}

/** Where a merge may go: open department of the same legal entity, never the unit itself or anything under it. */
export function mergeTargets(entity: Node, a: Node): { workplace: Node; options: { node: Node; depth: number; own: boolean }[] }[] {
  const own = new Set([a.id, ...descendants(a).map((x) => x.id)]);
  return entity.children
    .filter((w) => w.kind === "WORKPLACE" && !w.chips.includes("closed"))
    .map((w) => ({ workplace: w, options: flat(w, 0).filter((x) => x.node.id !== a.id).map((x) => ({ ...x, own: own.has(x.node.id) })) }));
}
const flat = (n: Node, depth: number): { node: Node; depth: number }[] => depts(n).flatMap((c) => [{ node: c, depth }, ...flat(c, depth + 1)]);

/** A new department after go-live (one CREATE op under its parent's unit). */
export const createGovOp = (parent: Node, name: string): GovOp => ({ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: unitIdOf(parent), name: name.trim() });
