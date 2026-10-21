import type { components } from "@console/api/schema";
import { descendants, parentOf } from "../../../reference/org/present";

type Unit = components["schemas"]["OrgUnitHead"];
type Kind = Unit["kind"];
type Change = components["schemas"]["OrgChangeSummary"];
type Revision = components["schemas"]["OrgUnitRevision"];

/**
 * The domain's nesting (decisions #18, one department kind): SITE under the company, a DEPARTMENT under a SITE or
 * another DEPARTMENT at any depth. The server reads a retired TEAM as DEPARTMENT; TEAM stays only for a cached unit.
 * Nothing is created under the company: a new SITE is a workplace, added through its legal entity (ENT-KIND MR-20).
 */
export const CHILD_KIND: Partial<Record<Kind, Kind>> = { SITE: "DEPARTMENT", DEPARTMENT: "DEPARTMENT", TEAM: "DEPARTMENT" };
export const PARENT_KINDS: Partial<Record<Kind, Kind[]>> = { SITE: ["COMPANY"], DEPARTMENT: ["SITE", "DEPARTMENT", "TEAM"], TEAM: ["SITE", "DEPARTMENT", "TEAM"] };

/** Children by parent id, in the server's order; dissolved units only when asked for. */
export function childIndex(units: Unit[], dissolved: boolean): Map<string, Unit[]> {
  const rootId = units.find((u) => u.kind === "COMPANY")?.id;
  const out = new Map<string, Unit[]>();
  for (const u of units) {
    const p = parentOf(u, rootId);
    if (!p || (u.status !== "ACTIVE" && !dissolved)) continue;
    out.set(p, [...(out.get(p) ?? []), u]);
  }
  return out;
}

/** The ids above `id`, nearest first. */
export function ancestorsOf(units: Unit[], id: string): string[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const rootId = units.find((u) => u.kind === "COMPANY")?.id;
  const out: string[] = [];
  for (let u = byId.get(id); u; ) {
    const p = parentOf(u, rootId);
    if (!p || out.includes(p)) break;
    out.push(p);
    u = byId.get(p);
  }
  return out;
}

export type Filter = { q: string; kinds: ReadonlySet<Kind>; dissolved: boolean };

/**
 * What a search or kind filter shows: the matching units and every ancestor of one (so a match keeps its
 * path), nothing else. Undefined when no filter is set (the whole tree shows). Case-insensitive substring
 * over the name; dissolved units only when `dissolved` is on.
 */
export function filterTree(units: Unit[], f: Filter): { matches: Set<string>; visible: Set<string> } | undefined {
  const q = f.q.trim().toLocaleLowerCase();
  if (!q && f.kinds.size === 0) return undefined;
  const matches = new Set(
    units
      .filter((u) => u.kind !== "COMPANY" && (u.status === "ACTIVE" || f.dissolved))
      .filter((u) => (!q || u.name.toLocaleLowerCase().includes(q)) && (f.kinds.size === 0 || f.kinds.has(u.kind)))
      .map((u) => u.id),
  );
  const visible = new Set(matches);
  for (const id of matches) ancestorsOf(units, id).forEach((a) => visible.add(a));
  return { matches, visible };
}

/** Root, sites and departments open; teams closed; the selection's path always open. */
export function defaultExpanded(units: Unit[], sel?: string): Set<string> {
  const out = new Set(units.filter((u) => u.kind !== "TEAM").map((u) => u.id));
  if (sel) ancestorsOf(units, sel).forEach((a) => out.add(a));
  return out;
}

/** Where a unit may move: active units of an allowed parent kind, not itself, its parent or anything below it. */
export function moveTargets(units: Unit[], unit: Unit): Unit[] {
  const kinds = PARENT_KINDS[unit.kind] ?? [];
  const below = descendants(units, unit.id);
  const rootId = units.find((u) => u.kind === "COMPANY")?.id;
  return units.filter((u) => u.status === "ACTIVE" && kinds.includes(u.kind) && u.id !== unit.id && u.id !== parentOf(unit, rootId) && !below.has(u.id));
}

export type MarkerKind = "due" | "scheduled" | "inApproval" | "settling" | "draft";
export type Marker = { kind: MarkerKind; change: Change; count: number; more: number };
const RANK: MarkerKind[] = ["due", "scheduled", "inApproval", "settling", "draft"];
const kindOf = (c: Change, today: string): MarkerKind | undefined =>
  c.status === "APPROVED" ? (c.effectiveDate <= today ? "due" : "scheduled")
  : c.status === "IN_APPROVAL" ? "inApproval"
  : c.status === "SETTLING" ? "settling"
  : c.status === "DRAFT" || c.status === "PRECHECKED" ? "draft"
  : undefined;

/**
 * One marker per row: the most urgent open change (approved and past its date, then approved, in approval,
 * settling, draft), the earliest-dated of that kind, how many share its kind, and how many others there are.
 */
export function markerOf(changes: Change[], today: string): Marker | undefined {
  const tagged = changes.flatMap((c) => {
    const k = kindOf(c, today);
    return k ? [{ k, c }] : [];
  });
  const top = RANK.find((k) => tagged.some((x) => x.k === k));
  if (!top) return undefined;
  const same = tagged.filter((x) => x.k === top).sort((a, b) => a.c.effectiveDate.localeCompare(b.c.effectiveDate));
  return { kind: top, change: same[0]!.c, count: same.length, more: tagged.length - same.length };
}

export type HistoryLine = (
  | { kind: "created"; date: string; name: string; actor: string | null; at: string }
  | { kind: "renamed"; date: string; from: string; to: string; actor: string | null; at: string }
  | { kind: "moved"; date: string; from: string | null; to: string | null; actor: string | null; at: string }
  | { kind: "code"; date: string; from: string | null; to: string | null; actor: string | null; at: string }
  | { kind: "head"; date: string; from: string | null; to: string | null; actor: string | null; at: string }
  | { kind: "merged"; date: string; into: string; actor: string | null; at: string }
  | { kind: "dissolved"; date: string; actor: string | null; at: string }) & { actorKind?: string | null; commandId?: string | null };

/** A unit's history as what changed, revision to revision (revisions arrive newest first); newest first. */
export function historyLines(revisions: Revision[]): HistoryLine[] {
  const asc = [...revisions].sort((a, b) => a.version - b.version);
  const out: HistoryLine[] = [];
  asc.forEach((r, i) => {
    const at = { date: r.effectiveFrom, actor: r.actorName, at: r.createdAt, actorKind:r.actorKind, commandId:r.commandId };
    const prev = asc[i - 1];
    if (!prev) return void out.push({ kind: "created", name: r.name, ...at });
    if (r.name !== prev.name) out.push({ kind: "renamed", from: prev.name, to: r.name, ...at });
    if (r.parentId !== prev.parentId) out.push({ kind: "moved", from: prev.parentId, to: r.parentId, ...at });
    // org-17: a code and a head change are history lines too, before → after, so the tab's count is the list's.
    if ((r.code ?? null) !== (prev.code ?? null)) out.push({ kind: "code", from: prev.code ?? null, to: r.code ?? null, ...at });
    if ((r.headEmployeeId ?? null) !== (prev.headEmployeeId ?? null)) out.push({ kind: "head", from: prev.headName ?? null, to: r.headName ?? null, ...at });
    if (r.status === "DISSOLVED" && prev.status !== "DISSOLVED")
      out.push(r.mergedInto ? { kind: "merged", into: r.mergedInto, ...at } : { kind: "dissolved", ...at });
  });
  return out.reverse();
}
