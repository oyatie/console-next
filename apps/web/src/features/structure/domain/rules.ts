// Where a unit may go (I-3, I-4): the editor makes an invalid parent impossible rather than refusing it after submit
// (decision #18). Pure. computed from the tree the client holds; the server's eligible parents per node
// (G11) replaces this when served, and the batch still refuses whatever this misses.
import type { ReorderRequest } from "@console/api/pending";
import { moved } from "../../../reference/org/domain/order";
import { descendants, type ChartNode, type Structure } from "./model";

/** Why a node is not a target: each value is a catalog suffix (structure.drop.<reason>). */
export type DropReason = "entityOnlySites" | "ownSubtree" | "deptOtherEntity" | "here" | "notMovable" | "siteOtherEntity" | "siteOrderOnly" | "entityOrderOnly";
export type Verdict = { ok: true } | { ok: false; reason: DropReason };

/** Only a department moves to a new parent (drag or M); a legal entity or a workplace is dragged only to change its order (orderVerdicts). */
export const movable = (n: ChartNode) => n.kind === "dept";
/** Dragged only to change its place among its siblings: a legal entity in the tenant, a workplace in its legal entity. */
export const reorderedByDrag = (n: ChartNode) => (n.kind === "entity" || n.kind === "site") && Boolean(n.parentId);

/**
 * A dragged legal entity's or workplace's verdict on every node (S11-invalid-move): only its siblings of the same level
 * take it (it lands right after the one it is dropped on); another legal entity, and anything else, says why not.
 */
export function orderVerdicts(s: Structure, node: ChartNode): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const n of s.byId.values())
    out.set(n.id, n.id === node.id ? { ok: false, reason: "here" }
      : n.kind === node.kind && n.parentId === node.parentId ? { ok: true }
      : node.kind === "entity" ? { ok: false, reason: "entityOrderOnly" }
      : n.entityId !== node.entityId ? { ok: false, reason: "siteOtherEntity" }
      : { ok: false, reason: "siteOrderOnly" });
  return out;
}

/** The parent a reorder names: none for the tenant (its legal entities), else the legal entity, workplace or department. */
const orderKey = (parent: ChartNode): Omit<ReorderRequest, "children"> =>
  parent.kind === "tenant" ? {} : parent.kind === "entity" ? { legal_entity_id: parent.id } : parent.kind === "site" ? { workplace_id: parent.id } : { org_unit_id: parent.id };

/** `n`'s siblings of its level, as read: the order a reorder pins (expected_children, so a stale one is refused). */
function siblings(s: Structure, n: ChartNode) {
  const parent = n.parentId ? s.byId.get(n.parentId) : undefined;
  return parent && { parent, ids: parent.children.filter((c) => c.kind === n.kind).map((c) => c.id) };
}
const request = (parent: ChartNode, children: string[], read: string[]): ReorderRequest => ({ ...orderKey(parent), children, expected_children: read });

/** The order request that puts `node` right after `target` among its siblings. */
export function placeAfter(s: Structure, node: ChartNode, target: ChartNode): ReorderRequest | undefined {
  const sib = siblings(s, node);
  if (!sib) return undefined;
  const ids = sib.ids.filter((id) => id !== node.id);
  ids.splice(ids.indexOf(target.id) + 1, 0, node.id);
  return request(sib.parent, ids, sib.ids);
}

/** Whether `target` can take `moving` as a child. */
export function canDrop(moving: ChartNode, target: ChartNode, below: ReadonlySet<string>): Verdict {
  if (!movable(moving)) return { ok: false, reason: "notMovable" };
  if (target.id === moving.id || below.has(target.id)) return { ok: false, reason: "ownSubtree" };
  if (target.kind === "tenant" || target.kind === "entity") return { ok: false, reason: "entityOnlySites" };
  if (target.entityId !== moving.entityId) return { ok: false, reason: "deptOtherEntity" };
  if (target.id === moving.parentId) return { ok: false, reason: "here" };
  return { ok: true };
}

/** Every node's verdict for moving all of `moving` (a node is a target only when it can take each one). */
export function verdicts(s: Structure, moving: readonly ChartNode[]): Map<string, Verdict> {
  const below = new Set(moving.flatMap((m) => descendants(m).map((d) => d.id)));
  const out = new Map<string, Verdict>();
  for (const n of s.byId.values()) {
    const all = moving.map((m) => canDrop(m, n, below));
    out.set(n.id, all.find((v) => !v.ok) ?? { ok: true });
  }
  return out;
}

/** The body a MOVE sends for `target`: a workplace by its id, a department by its own unit. */
export const parentOf = (target: ChartNode) => (target.kind === "site" ? { workplace_id: target.id } : { parent_org_unit_id: target.id });

/** The people whose workplace changes when `n` moves under `target` (a move to another workplace corrects placements). */
export const transfers = (n: ChartNode, target: ChartNode) => (n.siteId === (target.kind === "site" ? target.id : target.siteId) ? 0 : n.headcount);

/**
 * A selection with any node under another selected node dropped (it moves with its ancestor, and the bar says so),
 * in tree order.
 */
export function collapseSelection(s: Structure, ids: ReadonlySet<string>): { top: ChartNode[]; folded: ChartNode[] } {
  const chosen = [...ids].map((id) => s.byId.get(id)).filter((n): n is ChartNode => Boolean(n));
  const under = new Set(chosen.flatMap((n) => descendants(n).map((d) => d.id)));
  return { top: chosen.filter((n) => !under.has(n.id)), folded: chosen.filter((n) => under.has(n.id)) };
}

/**
 * The order request that moves `n` one place among its siblings (`step` −1 earlier, +1 later): the tenant orders its
 * legal entities, a legal entity its workplaces, a workplace or a department its departments; every current sibling
 * once, pinned to the order read. Undefined at either end.
 */
export function orderStep(s: Structure, n: ChartNode, step: -1 | 1): ReorderRequest | undefined {
  const sib = siblings(s, n);
  if (!sib || n.kind === "tenant") return undefined;
  const ids = moved(sib.ids, n.id, step);
  return ids.every((id, i) => id === sib.ids[i]) ? undefined : request(sib.parent, ids, sib.ids);
}

/** A sibling with the same name (NFC, trimmed) under `parent`, other than `self`: names are unique among open siblings (I-5). */
export function nameClash(parent: ChartNode, name: string, self?: string): ChartNode | undefined {
  const key = name.normalize("NFC").trim();
  return parent.children.find((c) => c.id !== self && c.name.normalize("NFC").trim() === key);
}
