// What an org change is called: by what it does (org-25: a rename or a merge reads as what it does), the same in the
// list, the record, its receipts and the chart's receipt. Pure: it says which phrase and its values; present.ts words it.
import type { components } from "@console/api/schema";

type Summary = components["schemas"]["OrgChangeSummary"];
type Op = components["schemas"]["OrgProposalOp"];

/** Name lookups over the loaded org; `undefined` when the id is not (or no longer) known. */
export type Names = { unit: (id?: string | null) => string | undefined; region: (id?: string | null) => string | undefined; branch: (id?: string | null) => string | undefined };

const UUID_LABEL = /^\S+ ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const short = (id?: string | null) => (id ? id.slice(0, 8) : "—");

/** The ids an op is about, in the order they name its subject. */
function opIds(op: Op): { unit?: string; region?: string; branch?: string } {
  switch (op.op) {
    case "DISSOLVE_ORG_UNIT": case "RENAME_ORG_UNIT": case "MOVE_ORG_UNIT": return { unit: op.orgUnitId };
    case "REASSIGN_ORG_UNIT": return { unit: op.fromOrgUnit };
    case "RENAME_REGION": case "DEACTIVATE_REGION": return { region: op.regionId };
    case "RENAME_BRANCH": case "DEACTIVATE_BRANCH": return { branch: op.branchId };
    default: return {};
  }
}

/** A phrase that names a change by what it does (`orgChange.title.<kind>`), with its values. */
export type OpsTitle =
  | { kind: "merge"; values: { name: string; into: string } }
  | { kind: "dissolve"; values: { name: string } }
  | { kind: "rename"; values: { from: string; to: string } }
  | { kind: "create"; values: { name: string } }
  | { kind: "move"; values: { name: string; parent: string } }
  | { kind: "moveMany"; values: { name: string; count: number; parent: string } }
  | { kind: "reassign"; values: { from: string; to: string } };

/**
 * The change named by what its ops do, or `undefined` when the ops do not make one phrase. A dissolution (or a merge,
 * with its successor) names the whole change: the moves of its people and sub-units are how it closes.
 */
export function opsTitle(ops: readonly Op[], n: Pick<Names, "unit">): OpsTitle | undefined {
  const name = (id?: string | null) => n.unit(id);
  const end = ops.find((op) => op.op === "DISSOLVE_ORG_UNIT");
  if (end) {
    const unit = name(end.orgUnitId);
    const into = end.mergedInto ? name(end.mergedInto) : undefined;
    if (!unit) return undefined;
    return into ? { kind: "merge", values: { name: unit, into } } : { kind: "dissolve", values: { name: unit } };
  }
  const unitOps = ops.filter((op) => op.op !== "REASSIGN_ORG_UNIT");
  const moves = unitOps.filter((op) => op.op === "MOVE_ORG_UNIT");
  const only = unitOps.length === 1 ? unitOps[0] : undefined;
  if (only?.op === "RENAME_ORG_UNIT") {
    const from = name(only.orgUnitId);
    return from ? { kind: "rename", values: { from, to: only.name } } : undefined;
  }
  if (only?.op === "CREATE_ORG_UNIT") return { kind: "create", values: { name: only.name } };
  const first = moves[0];
  // A bulk move renames clashing units and moves them all under one parent: named by the moves.
  if (first && unitOps.every((op) => op.op === "MOVE_ORG_UNIT" || op.op === "RENAME_ORG_UNIT")) {
    const unit = name(first.orgUnitId);
    const parent = name(first.parentId);
    if (!unit || !parent) return undefined;
    return moves.length === 1 ? { kind: "move", values: { name: unit, parent } } : { kind: "moveMany", values: { name: unit, count: moves.length - 1, parent } };
  }
  const reassign = ops.find((op) => op.op === "REASSIGN_ORG_UNIT");
  if (reassign && unitOps.length === 0) {
    const from = name(reassign.fromOrgUnit);
    const to = name(reassign.toOrgUnit);
    return from && to ? { kind: "reassign", values: { from, to } } : undefined;
  }
  return undefined;
}

/** What the change is about, by name: the new name for a creation, else the target or its first op, never a raw id. */
export function subjectOf(c: Summary & { proposal?: Op[] }, n: Names): string | undefined {
  if (c.kind === "NEW") {
    const created = c.proposal?.find((op) => "name" in op && op.op.startsWith("CREATE"));
    if (created && "name" in created && created.name) return created.name;
  } else {
    const ref = c.target.ref;
    const byRef = c.target.kind === "REGION" ? n.region(ref) : c.target.kind === "BRANCH" ? n.branch(ref) : n.unit(ref);
    if (byRef) return byRef;
    for (const op of c.proposal ?? []) {
      const ids = opIds(op);
      const name = n.unit(ids.unit) ?? n.region(ids.region) ?? n.branch(ids.branch);
      if (name) return name;
    }
    const id = UUID_LABEL.exec(c.target.label)?.[1];
    const byLabel = id && (n.unit(id) ?? n.region(id) ?? n.branch(id));
    if (byLabel) return byLabel;
  }
  const text = c.target.label.trim();
  return text && !UUID_LABEL.test(text) ? text : undefined;
}

/** The name of what a dissolution closes: a region, a branch or a unit. */
export function dissolvedName(d: Summary & { proposal: Op[] }, n: Names): string {
  for (const op of d.proposal) {
    if (op.op === "DEACTIVATE_REGION") return n.region(op.regionId) ?? short(op.regionId);
    if (op.op === "DEACTIVATE_BRANCH") return n.branch(op.branchId) ?? short(op.branchId);
    if (op.op === "DISSOLVE_ORG_UNIT") return n.unit(op.orgUnitId) ?? short(op.orgUnitId);
  }
  return subjectOf(d, n) ?? d.code;
}

/** A list row's own title: the label it was drafted with (org-25), when that is a phrase and not the unit name or an id. */
export function labelTitle(c: Summary & { proposal?: Op[] }, name: string): string | undefined {
  const label = c.target.label.trim();
  return !c.proposal && label && label !== name && !UUID_LABEL.test(label) ? label : undefined;
}
