import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CornerDownRight, History } from "lucide-react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { focusSoon } from "../../../lib/react/announce";
import { OrgCanvas, type CanvasHandle } from "../../../ui/org-canvas/org-canvas";
import { unzoomOf } from "../../../ui/org-canvas/use-view";
import { Receipt } from "../../../ui/receipt/receipt";
import { ChangeReceipt } from "../../../reference/org/ui/change-receipt";
import { useChangeNote } from "../../../reference/org/ui/use-change-note";
import { receiptAction } from "../../../ui/receipt/receipt-action";
import { Button } from "../../../ui/button/button";
import { todayKst } from "../../../lib/pure/today";
import { drawnAt, pathTo, type ChartNode, type Structure } from "../domain/model";
import { collapseSelection, movable } from "../domain/rules";
import { toolsSpot, WRAP_SITES, type Box } from "../domain/layout";
import { ChartBoxes } from "./chart-boxes";
import { ChartEditors } from "./chart-editors";
import { useChartKeys } from "./use-chart-keys";
import { ChartTop, FindStatus } from "./chart-top";
import { DeleteDialog } from "./delete-dialog";
import { useOpenDetail } from "./use-open-detail";
import { MovePicker } from "./move-picker";
import { NodeTools } from "./node-tools";
import type { Gestures } from "../present";
import { SelectionBar } from "./selection-bar";
import { StaleNotice } from "./stale-notice";
import { isStale, myId } from "../api";
import { HitPreview, SitePreview } from "./site-preview";
import { useChartState } from "./use-chart-state";
import { useDragMove } from "./use-drag-move";
import type { Commands } from "./use-structure-commands";
import { useStructureGestures } from "./use-structure-gestures";
import css from "./chart.module.css";

/**
 * The org chart (spec S1, S2): the laid-out tree on a pan/zoom canvas with its crumbs, find and depth control, the hover
 * toolbar, inline add and rename, drag and M to move, the selection bar, and the receipt docked in the gutter.
 * During setup every change applies at once (undoable); after go-live the gestures open the governed proposal.
 */
export function ChartView({ s, cmd, focusId, onFocus, sel, onSelect, quiet, pick, dimmed }: {
  s: Structure;
  /** The tree shown is the last one read (a re-read failed). */
  dimmed?: boolean;
  /** A unit picked from outside the chart: shown in place (its branch opened, the view panned), never by redrawing. */
  pick?: { id: string; n: number };
  cmd: Commands;
  focusId?: string;
  onFocus: (id: string | undefined) => void;
  /** The selection shared with list and the outline (the same ids). */
  sel: ReadonlySet<string>;
  onSelect: (ids: ReadonlySet<string>, gather?: boolean) => void;
  /** The receipt is shown elsewhere (the outline's foot). */
  quiet?: boolean;
}) {
  const c = useChartState(s, focusId, onFocus, sel, onSelect);
  const [picked, setPicked] = useState(pick?.n);
  if (pick && pick.n !== picked) {
    setPicked(pick.n);
    if (s.byId.has(pick.id) && pathTo(s, pick.id).some((n) => n.id === c.focus.id)) c.reveal(pick.id);
  }
  const canvas = useRef<CanvasHandle>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string>();
  const [menu, setMenu] = useState<string>();
  const [moving, setMoving] = useState<ChartNode[] | null>(null);
  const [deleting, setDeleting] = useState<ChartNode[] | null>(null);
  const openDetail = useOpenDetail();
  // A department's detail is its side panel (it is chosen); a legal entity or workplace has its record.
  const open = (n: ChartNode) => (n.kind === "dept" ? (c.select(n.id), c.setCursor(n.id)) : openDetail(n));
  const g = useStructureGestures(s, c, cmd, { move: setMoving, remove: setDeleting, onFocus });
  const drag = useDragMove(s, c.sel, (nodes, target) => g.moveTo(nodes, target));

  // An open add box comes into view clear of the floating bars (its field must not sit under the zoom bar).
  const ghost = c.L.boxes.find((b) => b.ghost);
  useLayoutEffect(() => {
    if (ghost) canvas.current?.reveal(ghost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost?.x, ghost?.y]);

  // The keyboard cursor follows into view, and DOM focus moves with it while it is on a box (never out of a field).
  // A find's result inside a compact workplace is shown by the tile it sits in.
  const cursorBox = c.shown.get(c.cursor) ?? c.shown.get(drawnAt(s, c.shown, c.cursor) ?? "");
  const hitId = c.q.trim() ? c.hits.ids[c.hit] : undefined;
  const hitTile = hitId && !c.shown.has(hitId) ? c.shown.get(drawnAt(s, c.shown, hitId) ?? "") : undefined;
  // A box pressed with the pointer is where the pointer is: panning it then would move it out from under the press
  // before the release, and the click would never land. Only the keyboard, a find or a pick pans.
  const pressed = useRef<string>(undefined);
  const sought = useRef(c.seek);
  // Before paint, so the pan lands in the same frame as the input that moved the cursor.
  useLayoutEffect(() => {
    const press = pressed.current;
    pressed.current = undefined;
    const find = sought.current !== c.seek;
    sought.current = c.seek;
    if (!cursorBox) return;
    if (!c.adding && (find || press !== c.cursor)) canvas.current?.reveal(cursorBox);
    if (document.activeElement?.getAttribute("role") === "treeitem" && stage.current?.contains(document.activeElement))
      document.getElementById(`node-${c.cursor}`)?.focus({ preventScroll: true });
    // Only a cursor move or a find (not every relayout: a box moving under a press is worse than one off screen).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.cursor, c.seek, c.adding]);

  // The toolbar stays while the pointer crosses the gap between a box and it.
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverAt = (el: HTMLElement) => {
    clearTimeout(leave.current);
    if (el.closest("[data-tools]")) return;
    const id = el.closest<HTMLElement>("[data-box][data-id]")?.dataset.id;
    if (id) setHover(id);
    else if (menu === undefined) leave.current = setTimeout(() => setHover(undefined), 250);
  };
  const only = c.sel.size === 1 ? [...c.sel][0] : undefined;
  const hoverBox = hover && !drag.dragging ? c.shown.get(hover) : undefined;
  // The root's header carries its own entries (RootActions): no hover toolbar over it.
  const toolsBoxes = drag.dragging || c.renaming ? [] : [...new Set([only, menu ?? hover])].flatMap((id) => {
    const b = id && id !== s.root.id ? c.shown.get(id) : undefined;
    return b ? [b] : [];
  });
  const spotFor = (b: Box, zoom: number, visible: Pick<Box, "x" | "y" | "w" | "h">) => toolsSpot(c.L, b, unzoomOf(zoom), undefined, undefined, visible);
  const gestures: Gestures = { add: g.add, rename: g.rename, move: (n) => g.move(pickMoving(n)), remove: (n) => g.remove(n.kind === "site" ? [n] : pickMoving(n)), focusOn: g.focusOn, merge: g.merge, order: g.order, open: (n) => open(n) };
  const pickMoving = (n: ChartNode) => (c.sel.has(n.id) ? collapseSelection(s, c.sel).top : [n]).filter(movable);
  const keys = useChartKeys(c, { ...gestures, open, menu: (n) => (setHover(n.id), setMenu(n.id)), find: () => focusSoon("structure-find") });

  // An org change made from the chart after go-live leaves its receipt in the same gutter (org-19).
  const note = useChangeNote();
  // A set width: a font subset swapping in for the message's glyphs never resizes it or moves its buttons after it paints.
  const receipt = cmd.last && (
    <div className={css.receipt}><Receipt
      state="applied"
      message={cmd.last.message}
      undoing={cmd.undoing}
      onUndo={cmd.last.undone ? undefined : cmd.undo}
      onDismiss={cmd.dismiss}
      actions={<Link to="/org/history" className={receiptAction}><History size={14} aria-hidden />{t("structureChart.history")}</Link>}
    /></div>
  );
  // Several chosen: their bar takes the gutter (S2-chart-multiselect), clear of the boxes like the receipt it replaces.
  const gutter = drag.view ? (
    <p className={`${css.hint} card`} role="status">{drag.view.over && drag.view.verdicts.get(drag.view.over)?.ok ? g.effect(drag.view.nodes, drag.view.over) : t("structure.drop.idle")}</p>
  ) : c.sel.size > 1 ? (
    <SelectionBar s={s} c={c} g={gestures} />
  ) : isStale(cmd.error) ? (
    <StaleNotice s={s} cmd={cmd} onMoveAgain={setMoving} />
  ) : cmd.error ? (
    <div className={css.failed}><CommandError error={cmd.error} /><Button variant="ghost" onClick={cmd.reset}>{t("structure.dismiss")}</Button></div>
  ) : c.q.trim() ? (
    <FindStatus s={s} c={c} />
  ) : cmd.last && !quiet ? receipt : note ? (
    <ChangeReceipt />
  ) : (
    <p className={`${css.hint} card`}>{c.L.lod === "far" ? t("structureChart.farHint", { wrap: WRAP_SITES }) : c.focus.kind === "tenant" ? t("structure.caption", { date: s.asOf ?? todayKst() }) : t("structure.hint")}</p>
  );

  return (
    <div className={css.chartWrap}>
      <OrgCanvas
        ref={canvas}
        label={t("structure.chart.label")}
        resetKey={c.focus.id}
        size={{ w: c.L.w, h: c.L.h }}
        keep={cursorBox}
        dimmed={dimmed}
        lines={c.L.lines.map((l) => l.d)}
        top={drag.view ? (
          // While dragging, the top edge says what is moving and how a drop is judged (S2-chart-drag).
          <p className={`${css.dragBanner} card`} role="status"><CornerDownRight size={16} aria-hidden /><b>{t("structure.drop.moving", { name: drag.view.nodes.map((n) => n.name).join(", ") })}</b>{t("structure.drop.rules")}</p>
        ) : <ChartTop s={s} c={c} onFocus={onFocus} onFind={(id) => c.reveal(id)} />}
        gutter={gutter}
        tools={<Button variant="ghost" onClick={() => c.setExpanded(new Set([c.focus.id]))}>{t("structure.collapseAll")}</Button>}
        layer={(zoom, visible) => (
          <>
            <ChartEditors s={s} c={c} zoom={zoom} visible={visible} pending={cmd.pending} batch={cmd.last?.batchId} onAdd={g.create} onRename={g.saveName} />
            {hitTile && hitId ? <HitPreview s={s} L={c.L} box={hitTile} hit={s.byId.get(hitId)!} at={c.hit + 1} total={c.hits.ids.length} />
              : hoverBox && (hoverBox.lod === "tile" || hoverBox.lod === "xs") && hoverBox.node.kind === "site" && <SitePreview L={c.L} box={hoverBox} />}
            {toolsBoxes.map((b) => <NodeTools key={b.node.id} box={b} spot={spotFor(b, zoom, visible)} g={gestures} canEdit={g.canEdit} onPointerDown={drag.onPointerDown} />)}
          </>
        )}
        minimap={{ userId: myId(), rects: c.L.boxes.filter((b) => b.node.kind !== "tenant").map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, level: b.node.kind, hit: c.sel.has(b.node.id) || c.hits.ids.includes(b.node.id) })) }}
        stageRef={(el) => void (stage.current = el)}
        stage={{
          role: "tree",
          "aria-label": t("structure.chart.treeLabel", { name: c.focus.kind === "tenant" ? t("structure.root.word") : c.focus.name }),
          "aria-multiselectable": true,
          onKeyDown: keys,
          onPointerDownCapture: (e) => void (pressed.current = (e.target as HTMLElement).closest<HTMLElement>("[data-box][data-id]")?.dataset.id),
          onPointerOver: (e) => hoverAt(e.target as HTMLElement),
          onContextMenu: (e) => {
            const id = (e.target as HTMLElement).closest<HTMLElement>("[data-box][data-id]")?.dataset.id;
            if (!id) return;
            e.preventDefault();
            setHover(id);
            setMenu(id);
          },
        }}
      >
        <ChartBoxes s={s} c={c} g={gestures} canEdit={g.canEdit} menu={menu} onMenu={setMenu} drag={drag.view} moved={cmd.last && !cmd.last.undone ? cmd.last.moved : undefined} onActivate={(id, mode) => (c.select(id, mode), c.setCursor(id))} onPointerDown={drag.onPointerDown} />
      </OrgCanvas>
      {drag.view && <span className={`${css.dragGhost} card`} ref={(el) => el?.style.setProperty("transform", `translate(${drag.view!.at.x + 12}px, ${drag.view!.at.y + 12}px)`)}>{drag.view.nodes.map((n) => n.name).join(", ")}</span>}
      {moving && moving.length > 0 && <MovePicker s={s} moving={moving} onClose={() => setMoving(null)} onMove={(tgt) => (g.moveTo(moving, tgt), setMoving(null))} />}
      {deleting && deleting.length > 0 && <DeleteDialog nodes={deleting} operating={!g.setup} onClose={() => setDeleting(null)} onDelete={() => (g.dissolve(deleting), setDeleting(null))} onOne={(n) => (setDeleting(null), g.dissolveOne(n))} />}
    </div>
  );
}
