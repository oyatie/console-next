// Before/after of a proposed unit change, from today's tree: what the proposal card's preview draws.
// The ops are the ones the card sends, replayed by applyOps, so the preview and the request cannot drift.
import type { components } from "@console/api/schema";
import { applyOps, parentOf, rollupHeadcount, type OpMark } from "../../../reference/org/present";

type Unit = components["schemas"]["OrgUnitHead"];
type Op = components["schemas"]["OrgProposalOp"];
export type Mark = "created" | "renamed" | "moved" | "dissolved";
export type PreviewNode = { id: string; name: string; kind: Unit["kind"]; count: number; mark?: Mark; delta?: number; children: PreviewNode[] };

/** The units each side shows: the parent (both parents for a move, both units for a member move). */
function focus(units: Unit[], op: Op): { ids: string[]; flat: boolean } {
  const rootId = units.find((u) => u.kind === "COMPANY")?.id;
  const parent = (id: string) => {
    const u = units.find((x) => x.id === id);
    return u ? parentOf(u, rootId) : null;
  };
  const ids =
    op.op === "CREATE_ORG_UNIT" ? [op.parentId ?? rootId ?? null]
    : op.op === "MOVE_ORG_UNIT" ? [parent(op.orgUnitId), op.parentId]
    : op.op === "REASSIGN_ORG_UNIT" ? [op.fromOrgUnit, op.toOrgUnit]
    : op.op === "RENAME_ORG_UNIT" || op.op === "DISSOLVE_ORG_UNIT" ? [parent(op.orgUnitId)]
    : [];
  return { ids: ids.filter((x): x is string => Boolean(x)), flat: op.op === "REASSIGN_ORG_UNIT" };
}

function tree(units: Unit[], roots: string[], flat: boolean, marks: Map<string, OpMark[]>, delta: (id: string) => number | undefined): PreviewNode[] {
  const rootId = units.find((u) => u.kind === "COMPANY")?.id;
  const counts = rollupHeadcount(units);
  const shown = (u: Unit) => u.status === "ACTIVE" || marks.has(u.id);
  const node = (u: Unit, deep: boolean): PreviewNode => ({
    id: u.id,
    name: u.name,
    kind: u.kind,
    count: counts.get(u.id) ?? u.headcount,
    mark: marks.get(u.id)?.find((m): m is Mark => m !== "gained" && m !== "lost"),
    delta: delta(u.id),
    children: deep ? units.filter((c) => c.kind !== "COMPANY" && shown(c) && parentOf(c, rootId) === u.id).map((c) => node(c, false)) : [],
  });
  return roots.flatMap((id) => {
    const u = units.find((x) => x.id === id);
    return u ? [node(u, !flat)] : [];
  });
}

/** Today's and the proposed structure around `op`, with roll-up headcounts, the changed node marked and members moved as ±n. */
export function preview(units: Unit[], op: Op): { before: PreviewNode[]; after: PreviewNode[] } {
  const { ids, flat } = focus(units, op);
  const next = applyOps(units, [op]);
  // The chip says who moves: the direct change. The roll-up of a unit receiving from its own sub-unit does not move.
  const direct = (list: Unit[], id: string) => list.find((u) => u.id === id)?.headcount ?? 0;
  const moved = (id: string) => (next.marks.get(id)?.some((m) => m === "gained" || m === "lost") ? direct(next.units, id) - direct(units, id) : undefined);
  return { before: tree(units, ids, flat, new Map(), () => undefined), after: tree(next.units, ids, flat, next.marks, moved) };
}
