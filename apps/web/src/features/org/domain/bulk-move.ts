// Moving several department at once (S8): what actually moves (a chosen department inside another chosen one travels with it),
// name clashes at the target and how each is resolved, exact counts, and the ops for setup or one proposal. Pure.
import type { SetupOp } from "@console/api/pending";
import { depts, descendants, direct, parentRef, unitIdOf, type Node, type Place } from "../../../reference/org/domain/structure";
import type { EiUnit } from "../../../reference/entity/domain/ei-unit";
import { viewOf, type GovOp, type View } from "./structure-plans";

/** How a department whose name is already taken under the target goes: renamed, merged into the one there, or left out. */
export type Resolution = { kind: "rename"; name: string } | { kind: "merge" } | { kind: "skip" };
export type Row = { node: Node; from: Place; sub: number; members: number; siteChanged: number; clash?: Node; resolution?: Resolution };

const fold = (s: string) => s.normalize("NFC").trim();

export function bulkPlan(places: Map<string, Place>, roots: readonly Node[], target: Place, resolutions: ReadonlyMap<string, Resolution>, ei: EiUnit) {
  const to = target.workplace!.id;
  const siblings = depts(target.node).filter((c) => !roots.some((r) => r.id === c.id));
  const rows: Row[] = roots.map((node) => {
    const from = places.get(node.id)!;
    const clash = siblings.find((s) => fold(s.name) === fold(node.name));
    const changed = from.workplace!.id === to ? 0 : node.headcount;
    return { node, from, sub: descendants(node).length, members: node.headcount, siteChanged: changed, clash, resolution: clash ? resolutions.get(node.id) : undefined };
  });
  const open = rows.filter((r) => r.clash && !r.resolution);
  // A rename that clashes again is not resolved yet.
  const taken = new Set(siblings.map((s) => fold(s.name)));
  const badRename = rows.filter((r) => r.resolution?.kind === "rename" && (!fold(r.resolution.name) || taken.has(fold(r.resolution.name))));
  const moving = rows.filter((r) => r.resolution?.kind !== "skip");
  const totals = {
    units: moving.reduce((n, r) => n + 1 + r.sub, 0),
    members: moving.reduce((n, r) => n + r.members, 0),
    siteChanged: moving.reduce((n, r) => n + r.siteChanged, 0),
    eiChanged: moving.reduce((n, r) => n + (ei(r.from.workplace!.id) === ei(to) ? 0 : r.members), 0),
  };
  // Headcount change per workplace: every workplace losing or gaining people.
  const delta = new Map<string, { node: Node; change: number }>();
  for (const r of moving) {
    if (!r.siteChanged) continue;
    const src = r.from.workplace!;
    delta.set(src.id, { node: src, change: (delta.get(src.id)?.change ?? 0) - r.members });
    delta.set(to, { node: target.workplace!, change: (delta.get(to)?.change ?? 0) + r.members });
  }
  const merges = moving.filter((r) => r.resolution?.kind === "merge");
  return {
    rows,
    totals,
    sites: [...delta.values()],
    ready: open.length === 0 && badRename.length === 0 && moving.length > 0,
    unresolved: open.length + badRename.length,
    /** A merge with direct members needs people moved, which the setup batch does not do (G10). */
    setupBlocked: merges.some((r) => direct(r.node) > 0),
    items: { moves: moving.filter((r) => r.resolution?.kind !== "merge").length, renames: moving.filter((r) => r.resolution?.kind === "rename").length, merges: merges.length },
    setupOps: () => setupOps(moving, target),
    govOps: (company: string) => govOps(moving, target, company),
    after: afterTree(target, moving),
  };
}

function setupOps(rows: Row[], target: Place): SetupOp[] {
  return rows.flatMap((r): SetupOp[] => {
    const v = r.node.version;
    if (r.resolution?.kind === "merge") {
      return [...depts(r.node).map((c): SetupOp => ({ op: "MOVE", org_unit_id: c.id, expected_version: c.version, parent_org_unit_id: r.clash!.id })), { op: "DISSOLVE", org_unit_id: r.node.id, expected_version: v }];
    }
    // Renamed first, so it never stands beside its namesake under the target.
    const rename: SetupOp[] = r.resolution?.kind === "rename" ? [{ op: "RENAME", org_unit_id: r.node.id, expected_version: v, name: r.resolution.name.trim() }] : [];
    return [...rename, { op: "MOVE", org_unit_id: r.node.id, expected_version: rename.length ? (v ?? 0) + 1 : v, ...parentRef(target.node) }];
  });
}

function govOps(rows: Row[], target: Place, company: string): GovOp[] {
  return rows.flatMap((r): GovOp[] => {
    if (r.resolution?.kind === "merge") {
      return [
        ...depts(r.node).map((c): GovOp => ({ op: "MOVE_ORG_UNIT", orgUnitId: c.id, parentId: r.clash!.id })),
        ...(direct(r.node) > 0 ? [{ op: "REASSIGN_ORG_UNIT", fromOrgUnit: r.node.id, toOrgUnit: r.clash!.id, scope: { company } } as GovOp] : []),
        { op: "DISSOLVE_ORG_UNIT", orgUnitId: r.node.id, mergedInto: r.clash!.id },
      ];
    }
    const rename: GovOp[] = r.resolution?.kind === "rename" ? [{ op: "RENAME_ORG_UNIT", orgUnitId: r.node.id, name: r.resolution.name.trim() }] : [];
    return [...rename, { op: "MOVE_ORG_UNIT", orgUnitId: r.node.id, parentId: unitIdOf(target.node) }];
  });
}

function afterTree(target: Place, rows: Row[]): View {
  const host = target.node;
  const gain = rows.reduce((n, r) => n + r.siteChanged, 0);
  const base = target.workplace!;
  const moved = rows
    .filter((r) => r.resolution?.kind !== "merge")
    .map((r): View => ({
      ...viewOf(r.node, 1),
      name: r.resolution?.kind === "rename" ? r.resolution.name.trim() : r.node.name,
      tag: r.resolution?.kind === "rename" ? "movedRenamed" : "movedIn",
      children: depts(r.node).map((c) => ({ ...viewOf(c, 0), tag: "carried" as const })),
    }));
  const merged = new Map(rows.filter((r) => r.resolution?.kind === "merge").map((r) => [r.clash!.id, r]));
  const show = (n: Node): View => {
    const m = merged.get(n.id);
    const own = depts(n).map((c) => (merged.has(c.id) ? show(c) : viewOf(c, 0)));
    return m ? { ...viewOf(n, 0), n: n.headcount + m.members, tag: "merged", extra: m.members, children: own } : { ...viewOf(n, 0), children: own };
  };
  if (host.id === base.id) return { ...show(base), n: base.headcount + gain, children: [...show(base).children, ...moved] };
  return { ...viewOf(base, 0), n: base.headcount + gain, children: [{ ...show(host), n: host.headcount + rows.reduce((n, r) => n + r.members, 0), children: [...show(host).children, ...moved] }] };
}
