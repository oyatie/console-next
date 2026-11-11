import { useNavigate, getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCan } from "../../../reference/authz/ui/use-can";
import { useUnitEdit } from "../../../reference/org/ui/use-unit-edit";
import type { InlineUnitValues } from "../../../reference/org/api";
import type { SetupOp } from "../api";
import type { ChartNode, Structure } from "../domain/model";
import { orderStep, reorderedByDrag } from "../domain/rules";
import type { ChartState } from "./use-chart-state";
import type { Commands } from "./use-structure-commands";
import { useStructureGesturesBare } from "./use-outline-edit";

const route = getRouteApi("/app/org");
const pin = (n: ChartNode) => ({ org_unit_id: n.id, expected_version: n.version ?? 1 });

/** One server-derived draft decision, shared by the structure page's editing surfaces. */
export function useStructureEdit(setup: boolean, readOnly = false) {
  const can = useCan();
  return !readOnly && (setup || can("org_change_draft"));
}

/**
 * What each gesture does in the current phase. In setup a change is one batch, applied at once and
 * undoable. After go-live the same gesture opens the structure sheet for that unit (`?act=`: an org change with its
 * date and reason, applied or scheduled per the tenant's approval policy, decisions #26); moving opens the bulk move
 * page (S8). A single department deleted in setup opens its delete sheet (S6: where its members and sub-departments go).
 */
export function useStructureGestures(s: Structure, c: ChartState, cmd: Commands, ui: { move: (n: ChartNode[]) => void; remove: (n: ChartNode[]) => void; onFocus: (id: string | undefined) => void }) {
  const navigate = useNavigate();
  const nav = route.useNavigate();
  const setup = s.phase === "SETUP";
  const readOnly = s.readOnly || cmd.readOnly;
  const canEdit = useUnitEdit(setup, readOnly);
  const bare = useStructureGesturesBare(s, cmd);
  const propose = (n: ChartNode, act: "create" | "rename" | "move" | "dissolve") => {
    if (readOnly) return;
    if (act === "move") return void navigate({ to: "/org/move", search: { ids: n.id } });
    // The sheet names the selection: a workplace or a department by its own id.
    const sheet = { create: "dept-add", rename: "dept-rename", dissolve: n.kind === "site" ? (setup ? "wp-delete" : "wp-close") : "dept-delete" } as const;
    void nav({ search: (q) => ({ ...q, sel: n.id, act: sheet[act], kind: undefined }) });
  };

  const add = (n: ChartNode) => {
    if (!canEdit) return;
    if (n.kind === "tenant") return void navigate({ to: "/org/entities/new" });
    if (n.kind === "entity") return void navigate({ to: "/org/entities/$id/workplaces/new", params: { id: n.id } });
    c.toggle(n.id, true);
    c.setAdding(n.id);
  };
  const create = (parentId: string, name: string, values: InlineUnitValues, done?: () => void) => {
    if (!canEdit) return;
    const p = s.byId.get(parentId);
    if (!p) return;
    if (!setup) {
      return cmd.propose({ kind: "create", parentUnitId: p.unitId ?? p.id, name, ...values, onDone: (ids) => { done?.(); if (ids[0]) { c.setCursor(ids[0]); void nav({ search: (q) => ({ ...q, sel: ids[0], act: undefined }) }); } } });
    }
    const op: SetupOp = { op: "CREATE", name, ...(p.kind === "site" ? { workplace_id: p.id } : { parent_org_unit_id: p.id }) };
    // The new box comes into view (the add box stays open under it for the next name).
    cmd.apply({ ops: [op], message: t("structure.receipt.created", { name }), onDone: (ids) => { done?.(); if (ids[0]) c.setCursor(ids[0]); } });
  };
  const rename = (n: ChartNode) => (!canEdit || n.kind !== "dept" ? undefined : c.setRenaming(n.id));
  const saveName = (id: string, name: string, values: InlineUnitValues) => {
    if (!canEdit) return;
    const n = s.byId.get(id);
    if (!n) return;
    if (!setup) return cmd.propose({ kind: "rename", orgUnitId: n.id, fromName: n.name, name, ...values, onDone: () => c.setRenaming(null) });
    c.setRenaming(null);
    cmd.apply({ ops: [{ op: "RENAME", ...pin(n), name }], message: t("structure.receipt.renamed", { from: n.name, name }) });
  };
  const moveTo = (nodes: ChartNode[], target: ChartNode) => {
    // The new parent opens, so the moved boxes are in view where they landed once the tree is read again.
    if (!readOnly && setup && nodes[0] && !reorderedByDrag(nodes[0])) c.toggle(target.id, true);
    bare.moveTo(nodes, target);
  };
  const dissolve = (nodes: ChartNode[]) => {
    if (readOnly || !nodes.length) return;
    if (!setup) return propose(nodes[0]!, "dissolve");
    const name = nodes.length === 1 ? nodes[0]!.name : t("structure.move.many", { count: nodes.length });
    c.setSel(new Set());
    cmd.apply({ ops: nodes.map((n) => ({ op: "DISSOLVE", ...pin(n) })), message: t("structure.receipt.deleted", { name }) });
  };
  // Setup asks where (or confirms the delete) and applies; after go-live the proposal card asks, so it opens directly.
  const move = (nodes: ChartNode[]) => (readOnly ? undefined : setup ? ui.move(nodes) : nodes[0] && propose(nodes[0], "move"));
  const remove = (nodes: ChartNode[]) => (readOnly ? undefined : nodes.length > 1 ? ui.remove(nodes) : nodes[0] && propose(nodes[0], "dissolve"));
  const dissolveOne = (n: ChartNode) => (readOnly ? undefined : propose(n, "dissolve"));
  const order = (n: ChartNode, step: -1 | 1) => {
    if (readOnly) return;
    const body = orderStep(s, n, step);
    return body && (() => cmd.order(body, t(step < 0 ? "orgStructure.order.upDone" : "orgStructure.order.downDone", { name: n.name })));
  };
  const merge = (n: ChartNode) => {
    if (readOnly) return;
    void nav({ search: (q) => ({ ...q, sel: n.id, act: "dept-merge", kind: undefined }) });
  };
  // Showing one unit makes it the chart's root: the choice is let go, so no side panel narrows the focused chart (S2).
  const focusOn = (n: ChartNode) => {
    c.setSel(new Set());
    ui.onFocus(n.kind === "tenant" ? undefined : n.id);
  };
  return { canEdit, setup, add, create, rename, saveName, move, remove, moveTo, dissolve, dissolveOne, focusOn, merge, order, effect: bare.effect };
}
