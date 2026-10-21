import { useNavigate, getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCan } from "../../../reference/authz/ui/use-can";
import type { SetupOp } from "../api";
import type { ChartNode, Structure } from "../domain/model";
import { orderStep, parentOf, placeAfter, reorderedByDrag, transfers } from "../domain/rules";
import { moveEffect } from "../present";
import type { ChartState } from "./use-chart-state";
import type { Commands } from "./use-structure-commands";

const route = getRouteApi("/app/org");
const pin = (n: ChartNode) => ({ org_unit_id: n.id, expected_version: n.version ?? 1 });

/**
 * What each gesture does in the current phase. In setup a change is one batch, applied at once and
 * undoable. After go-live the same gesture opens the structure sheet for that unit (`?act=`: an org change with its
 * date and reason, applied or scheduled per the tenant's approval policy, decisions #26); moving opens the bulk move
 * page (S8). A single department deleted in setup opens its delete sheet (S6: where its members and sub-departments go).
 */
export function useStructureGestures(s: Structure, c: ChartState, cmd: Commands, ui: { move: (n: ChartNode[]) => void; remove: (n: ChartNode[]) => void; onFocus: (id: string | undefined) => void }) {
  const navigate = useNavigate();
  const nav = route.useNavigate();
  const can = useCan();
  const setup = s.phase === "SETUP";
  const readOnly = s.readOnly || cmd.readOnly;
  const canEdit = !readOnly && (setup || can("org_change_draft"));
  const propose = (n: ChartNode, act: "create" | "rename" | "move" | "dissolve") => {
    if (readOnly) return;
    if (act === "move") return void navigate({ to: "/org/move", search: { ids: n.id } });
    // The sheet names the selection: a workplace or a department by its own id.
    const sheet = { create: "dept-add", rename: "dept-rename", dissolve: n.kind === "site" ? (setup ? "wp-delete" : "wp-close") : "dept-delete" } as const;
    void nav({ search: (q) => ({ ...q, sel: n.id, act: sheet[act], kind: undefined }) });
  };

  const add = (n: ChartNode) => {
    if (readOnly) return;
    if (n.kind === "tenant") return void navigate({ to: "/org/entities/new" });
    if (n.kind === "entity") return void navigate({ to: "/org/entities/$id/workplaces/new", params: { id: n.id } });
    if (!setup) return propose(n, "create");
    c.toggle(n.id, true);
    c.setAdding(n.id);
  };
  const create = (parentId: string, name: string) => {
    if (readOnly) return;
    const p = s.byId.get(parentId);
    if (!p) return;
    const op: SetupOp = { op: "CREATE", name, ...(p.kind === "site" ? { workplace_id: p.id } : { parent_org_unit_id: p.id }) };
    // The new box comes into view (the add box stays open under it for the next name).
    cmd.apply({ ops: [op], message: t("structure.receipt.created", { name }), onDone: (ids) => ids[0] && c.setCursor(ids[0]) });
  };
  const rename = (n: ChartNode) => (readOnly || n.kind !== "dept" ? undefined : setup ? c.setRenaming(n.id) : propose(n, "rename"));
  const saveName = (id: string, name: string) => {
    if (readOnly) return;
    const n = s.byId.get(id);
    if (!n) return;
    c.setRenaming(null);
    cmd.apply({ ops: [{ op: "RENAME", ...pin(n), name }], message: t("structure.receipt.renamed", { from: n.name, name }) });
  };
  const moveTo = (nodes: ChartNode[], target: ChartNode) => {
    if (readOnly || !nodes.length) return;
    // A legal entity or a workplace is dragged only to reorder it (at once in either phase): it lands right after the sibling it is dropped on.
    if (reorderedByDrag(nodes[0]!)) {
      const body = placeAfter(s, nodes[0]!, target);
      return body && cmd.order(body, t("structureChart.drop.siteDone", { name: nodes[0]!.name, target: target.name }));
    }
    if (!setup) return propose(nodes[0]!, "move");
    const moved = nodes.reduce((k, n) => k + transfers(n, target), 0);
    const name = nodes.length === 1 ? nodes[0]!.name : t("structure.move.many", { count: nodes.length });
    const sub = nodes.reduce((k, n) => k + n.children.length, 0);
    // The new parent opens, so the moved boxes are in view where they landed once the tree is read again.
    c.toggle(target.id, true);
    // Each moved box says where it came from until the receipt goes (S2-chart-moved).
    const from = new Map(nodes.map((n) => [n.id, (n.parentId && s.byId.get(n.parentId)?.name) || ""]));
    cmd.apply({ ops: nodes.map((n) => ({ op: "MOVE", ...pin(n), ...parentOf(target) })), message: t("structure.receipt.moved", { name, target: target.name, sub, moved }), moved: from });
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
  const effect = (nodes: ChartNode[], overId: string) => {
    const target = s.byId.get(overId);
    if (target && nodes[0] && reorderedByDrag(nodes[0])) return t(nodes[0].kind === "entity" ? "structureChart.drop.entityAfter" : "structureChart.drop.siteAfter", { name: nodes[0].name, target: target.name });
    return target ? moveEffect(nodes, target) : "";
  };
  return { canEdit, setup, add, create, rename, saveName, move, remove, moveTo, dissolve, dissolveOne, focusOn, merge, order, effect };
}
