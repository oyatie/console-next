import { t } from "@console/i18n";
import type { components } from "@console/api/schema";
import { label, ORG_CHANGE_KIND } from "../../lib/labels";

type Unit = components["schemas"]["OrgUnitHead"];
type Summary = components["schemas"]["OrgChangeSummary"];
type Op = components["schemas"]["OrgProposalOp"];

/** A COMPANY-parented create carries the nil uuid as its target ref (server `parentId ?? nil`). */
const NIL = "00000000-0000-0000-0000-000000000000";

/** Full path for display, e.g. "HQ › HR › Recruiting". */
export function unitPath(units: Unit[], u: Unit): string {
  const byId = new Map(units.map((x) => [x.id, x]));
  const parts: string[] = [];
  for (let x: Unit | undefined = u; x && x.kind !== "COMPANY"; x = x.parentId ? byId.get(x.parentId) : undefined) parts.unshift(x.name);
  return parts.join(" › ");
}

/** A unit's parent id; a SITE written before the root was projected has `parentId: null` and sits under the root. */
export const parentOf = (u: Unit, rootId?: string) => u.parentId ?? (u.kind === "SITE" ? rootId ?? null : null);

/** Every unit below `id` (any status), not `id` itself. */
export function descendants(units: Unit[], id: string): Set<string> {
  const rootId = units.find((u) => u.kind === "COMPANY")?.id;
  const out = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of units) {
      const p = parentOf(u, rootId);
      if (p && (p === id || out.has(p)) && !out.has(u.id) && u.id !== id) {
        out.add(u.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Headcount including every ACTIVE unit below. `OrgUnitHead.headcount` counts direct members only; the
 * COMPANY root already counts the whole tenant, so it keeps its own number. Dissolved units keep theirs.
 */
export function rollupHeadcount(units: Unit[]): Map<string, number> {
  const active = units.filter((u) => u.status === "ACTIVE" && u.kind !== "COMPANY");
  const out = new Map(units.map((u) => [u.id, u.headcount]));
  for (const u of active) {
    const below = descendants(active, u.id);
    out.set(u.id, u.headcount + active.filter((x) => below.has(x.id)).reduce((n, x) => n + x.headcount, 0));
  }
  return out;
}

/** The unit ids a proposal op names (a create counts under its parent). */
export function opUnits(op: Op, rootId?: string): string[] {
  switch (op.op) {
    case "CREATE_ORG_UNIT":
      return [op.parentId ?? rootId ?? NIL];
    case "RENAME_ORG_UNIT":
    case "DISSOLVE_ORG_UNIT":
      return [op.orgUnitId];
    case "MOVE_ORG_UNIT":
      return [op.orgUnitId, op.parentId];
    case "REASSIGN_ORG_UNIT":
      return [op.fromOrgUnit, op.toOrgUnit];
    default:
      return [];
  }
}

const push = <C>(m: Map<string, C[]>, k: string, c: C) => {
  const list = m.get(k) ?? [];
  if (!list.includes(c)) m.set(k, [...list, c]);
};

/**
 * Open changes per unit id. A summary is matched by its ORG_UNIT target ref (the parent for a create; the
 * nil ref of a site create maps to the root); a detail, when given, also by every unit its ops name.
 */
export function openChangesByUnit<C extends Summary & { proposal?: Op[] }>(changes: C[], rootId?: string): Map<string, C[]> {
  const out = new Map<string, C[]>();
  for (const c of changes) {
    if (c.target.kind === "ORG_UNIT") push(out, c.target.ref === NIL && rootId ? rootId : c.target.ref, c);
    for (const op of c.proposal ?? []) for (const id of opUnits(op, rootId)) push(out, id, c);
  }
  return out;
}

/** Open changes per region or branch id, by target (a branch create targets its region). */
export function openChangesByRef<C extends Summary>(changes: C[], kind: "REGION" | "BRANCH"): Map<string, C[]> {
  const out = new Map<string, C[]>();
  for (const c of changes) if (c.target.kind === kind && c.target.ref !== NIL) push(out, c.target.ref, c);
  return out;
}

/** The server's placeholder labels for targets it named by id only. */
const PLACEHOLDER = /^(OrgUnit|Region|Branch) [0-9a-f-]{36}$/;
const ID_OF = (op: Op): [Lookup, string] | undefined => {
  switch (op.op) {
    case "RENAME_ORG_UNIT":
    case "MOVE_ORG_UNIT":
    case "DISSOLVE_ORG_UNIT":
      return ["unit", op.orgUnitId];
    case "REASSIGN_ORG_UNIT":
      return ["unit", op.fromOrgUnit];
    case "RENAME_REGION":
    case "DEACTIVATE_REGION":
      return ["region", op.regionId];
    case "RENAME_BRANCH":
    case "DEACTIVATE_BRANCH":
      return ["branch", op.branchId];
    default:
      return undefined;
  }
};
type Lookup = "unit" | "region" | "branch";
const LOOKUP: Partial<Record<Summary["target"]["kind"], Lookup>> = { ORG_UNIT: "unit", REGION: "region", BRANCH: "branch" };

/**
 * What a change acts on, never a raw id: the target label unless it is the server's id placeholder, else the
 * target ref's name, else the first op's unit, region or branch name, else the change code. `name` returns
 * undefined for an unknown id.
 */
function changeSubject(c: Summary & { proposal?: Op[] }, name: (kind: Lookup, id: string) => string | undefined): string {
  const by = LOOKUP[c.target.kind];
  const op = c.proposal?.map(ID_OF).find(Boolean);
  return (
    (!PLACEHOLDER.test(c.target.label) && c.target.label.trim()) ||
    (by && c.target.ref !== NIL && name(by, c.target.ref)) ||
    (op && name(...op)) ||
    c.code
  );
}

/** A change's display title, "{kind} · {name}" (e.g. "Dissolve · Recruiting"). */
export function changeTitle(c: Summary & { proposal?: Op[] }, name: (kind: Lookup, id: string) => string | undefined): string {
  return `${label(ORG_CHANGE_KIND, c.kind)} · ${changeSubject(c, name)}`;
}

/** What an op does to the tree: a projected unit carries these marks. */
export type OpMark = "created" | "renamed" | "moved" | "dissolved" | "gained" | "lost";

/**
 * Replays org-unit ops over today's units (region, branch and site ops do not touch the tree). New units get
 * the id `new:<n>`; a reassign moves the source's direct headcount to the target. The result is a projection
 * from today's structure, not the server's apply.
 */
export function applyOps(units: Unit[], ops: Op[]): { units: Unit[]; marks: Map<string, OpMark[]> } {
  const rootId = units.find((u) => u.kind === "COMPANY")?.id ?? null;
  const out = new Map(units.map((u) => [u.id, { ...u }]));
  const marks = new Map<string, OpMark[]>();
  const mark = (id: string, m: OpMark) => marks.set(id, [...(marks.get(id) ?? []), m]);
  ops.forEach((op, i) => {
    switch (op.op) {
      case "CREATE_ORG_UNIT": {
        const id = `new:${i}`;
        out.set(id, { id, kind: op.kind, name: op.name, parentId: op.parentId ?? rootId, status: "ACTIVE", effectiveFrom: "", headcount: 0, updatedAt: "" });
        return mark(id, "created");
      }
      case "RENAME_ORG_UNIT": {
        const u = out.get(op.orgUnitId);
        if (!u) return;
        u.name = op.name;
        return mark(u.id, "renamed");
      }
      case "MOVE_ORG_UNIT": {
        const u = out.get(op.orgUnitId);
        if (!u) return;
        u.parentId = op.parentId;
        return mark(u.id, "moved");
      }
      case "DISSOLVE_ORG_UNIT": {
        const u = out.get(op.orgUnitId);
        if (!u) return;
        u.status = "DISSOLVED";
        return mark(u.id, "dissolved");
      }
      case "REASSIGN_ORG_UNIT": {
        const from = out.get(op.fromOrgUnit), to = out.get(op.toOrgUnit);
        if (!from || !to) return;
        to.headcount += from.headcount;
        from.headcount = 0;
        mark(from.id, "lost");
        return mark(to.id, "gained");
      }
    }
  });
  return { units: [...out.values()], marks };
}

/** Direct members and the subtree total have the same meaning on every unit surface. */
export const unitCounts = (n: { headcount: number; children: readonly { headcount: number }[] }) =>
  t("structure.unitCounts", { direct: Math.max(0, n.headcount - n.children.reduce((sum, c) => sum + c.headcount, 0)), total: n.headcount });
