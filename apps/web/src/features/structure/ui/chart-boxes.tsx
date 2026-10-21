import { t } from "@console/i18n";
import { MoreHorizontal } from "lucide-react";
import { ActionMenu } from "../../../ui/menu/action-menu";
import { NodeActions } from "../../../ui/org-canvas/node-actions";
import { NodeBadge, NodeMore, NodeTag, OrgNode, type NodeState } from "../../../ui/org-canvas/org-node";
import type { Box } from "../domain/layout";
import { drawnAt, type Structure } from "../domain/model";
import type { DropReason } from "../domain/rules";
import type { ChartState } from "./use-chart-state";
import type { DragView } from "./use-drag-move";
import { NodeContent } from "./node-content";
import { menuActions, nodeLabel, temporalLabel, type Gestures } from "../present";
import css from "./chart.module.css";

/** Whether a box's children are drawn: open, and not a compact workplace (a tile or a one-line box never draws them). */
const drawsChildren = (b: Box, c: ChartState) => (c.expanded.has(b.node.id) || b.node.id === c.focus.id) && b.lod !== "tile" && b.lod !== "xs";

/**
 * Every box of the laid-out chart as a treeitem (flat, with aria-level: the boxes are positioned, not nested), the
 * expander under it. The add box, the rename box and the next-step slots are drawn by ChartEditors in the canvas
 * layer (outside the tree role). States: selection (fill), the keyboard cursor (ink
 * outline, D15), search hits and the current one ("now"), and while dragging the drop marks (D6).
 */
export function ChartBoxes({ s, c, g, canEdit, menu, onMenu, drag, moved, onActivate, onPointerDown }: {
  s: Structure;
  c: ChartState;
  g: Gestures;
  canEdit: boolean;
  menu?: string;
  onMenu: (id: string | undefined) => void;
  drag: DragView | null;
  /** Boxes a move just landed, with the parent each came from. */
  moved?: ReadonlyMap<string, string>;
  onActivate: (id: string, mode: "only" | "toggle") => void;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
}) {
  const hits = new Set(c.hits.ids);
  // The result shown, or the drawn box it sits in (a compact workplace never draws its departments).
  const now = c.hits.ids[c.hit] && drawnAt(s, c.shown, c.hits.ids[c.hit]!);
  const states = (b: Box): NodeState[] => {
    const id = b.node.id;
    const out: NodeState[] = [];
    if (b.node.scheduledBy) out.push("scheduled");
    if (b.node.diffMarks?.includes("gone")) out.push("gone");
    if (c.sel.has(id)) out.push(c.sel.size > 1 ? "multi" : "sel");
    if (now === id) out.push("now");
    else if (hits.has(id) || (!drawsChildren(b, c) && c.hits.perAncestor.has(id))) out.push("hit");
    if (drag) {
      const v = drag.verdicts.get(id);
      if (drag.over === id && v?.ok) out.push("drop");
      else if (v?.ok && drag.siblingsOfOver.has(id)) out.push("ok");
      else if (!v?.ok && !drag.moving.has(id)) out.push("dim");
    }
    return out;
  };
  const why = (b: Box): DropReason | undefined => {
    const v = drag?.over === b.node.id ? drag.verdicts.get(b.node.id) : undefined;
    return v && !v.ok && v.reason !== "here" ? v.reason : undefined;
  };
  return (
    <>
      {c.L.boxes.map((b) => {
        const n = b.node;
        if (b.slot || b.ghost) return null;
        const open = drawsChildren(b, c);
        const inside = !open ? c.hits.perAncestor.get(n.id) : undefined;
        const reason = why(b);
        return (
          <OrgNode
            key={n.id}
            id={`node-${n.id}`}
            data-id={n.id}
            data-scheduled={n.scheduledBy ? "true" : undefined}
            data-diff={n.diffMarks?.join(" ")}
            role="treeitem"
            aria-level={n.depth - c.focus.depth + 1}
            aria-label={nodeLabel(n)}
            aria-selected={c.sel.has(n.id)}
            aria-expanded={n.children.length ? open : undefined}
            tabIndex={c.cursor === n.id ? 0 : -1}
            level={n.kind}
            box={b}
            tile={b.lod === "tile"}
            states={states(b)}
            className={drag?.moving.has(n.id) ? css.dragSource : undefined}
            onFocus={() => c.setCursor(n.id)}
            onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("button, a, [role=menu]")) onPointerDown(e, n.id); }}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button, a, [role=menu]")) return;
              // A click puts keyboard focus on the box too (Safari and a transformed stage do not always), so its keys work next.
              e.currentTarget.focus({ preventScroll: true });
              onActivate(n.id, e.shiftKey || e.ctrlKey || e.metaKey ? "toggle" : "only");
            }}
          >
            <NodeContent box={b} counts={s.counts} badge={inside != null && <NodeBadge>{inside}</NodeBadge>} />
            {canEdit && n.kind !== "tenant" && (c.sel.has(n.id) || menu === n.id) && (
              <NodeActions>
                <ActionMenu label={t("structure.menu.label", { name: n.name })} trigger={<MoreHorizontal size={16} aria-hidden />} actions={menuActions(n, g)} open={menu === n.id} onOpenChange={(o) => onMenu(o ? n.id : undefined)} />
              </NodeActions>
            )}
            {(n.scheduledBy || n.changedAfter || n.diffMarks?.length) && <NodeTag tone="new">{temporalLabel(n)}</NodeTag>}
            {now === n.id ? <NodeTag tone="hit">{t("structure.find.now")}</NodeTag>
              : moved?.has(n.id) && <NodeTag tone="new">{t("structureChart.moved", { from: moved.get(n.id) ?? "" })}</NodeTag>}
            {b.more != null && (
              <NodeMore
                open={false}
                label={t(n.kind === "site" ? "structure.node.moreSite" : "structure.node.moreDept", { count: b.more })}
                aria-label={t("structure.node.expand", { name: n.name, count: b.more })}
                onToggle={() => c.toggle(n.id, true)}
              />
            )}
            {open && n.children.length > 0 && n.id !== c.focus.id && n.kind !== "entity" && (
              <NodeMore open label={t("structure.node.collapse")} aria-label={t("structure.node.collapseLabel", { name: n.name })} onToggle={() => c.toggle(n.id, false)} />
            )}
            {reason && <span className={css.why} role="status">{t(`structure.drop.${reason}`)}</span>}
          </OrgNode>
        );
      })}
    </>
  );
}
