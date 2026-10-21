import { Building2 } from "lucide-react";
import { tg } from "@console/i18n/gallery";
import { ActionMenu } from "../menu/action-menu";
import { OrgCanvas } from "./org-canvas";
import { NodeFoot, NodeKicker, NodeMore, NodeRow, NodeTag, OrgNode } from "./org-node";

export const order = 84;

const at = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/** Levels by their top edge, selection, a current search hit, drop marks, an expander and a verb menu. */
export default function OrgCanvasGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.orgCanvas")}</h2>
      <div className="gallery__canvas">
        <OrgCanvas label={tg("orgCanvas.label")} resetKey="g" size={{ w: 760, h: 300 }} lines={[]} minimap={false}>
          <OrgNode level="tenant" box={at(200, 24, 352, 80)}>
            <NodeRow name={tg("orgCanvas.tenant")} count={tg("orgCanvas.count")} />
          </OrgNode>
          <OrgNode level="entity" box={at(32, 156, 256, 96)} states={["sel"]}>
            <NodeKicker icon={<Building2 size={14} aria-hidden />}>{tg("orgCanvas.kicker")}</NodeKicker>
            <NodeRow name={tg("orgCanvas.entity")} count={tg("orgCanvas.count")} />
            <NodeFoot>{tg("orgCanvas.foot")}</NodeFoot>
          </OrgNode>
          <OrgNode level="site" box={at(312, 156, 224, 56)} states={["now"]}>
            <NodeRow name={tg("orgCanvas.site")} count={tg("orgCanvas.small")} />
            <NodeTag tone="hit">{tg("orgCanvas.now")}</NodeTag>
          </OrgNode>
          <OrgNode level="dept" box={at(560, 156, 192, 56)} states={["drop"]}>
            <NodeRow name={tg("orgCanvas.dept")} count={tg("orgCanvas.small")} />
            <NodeMore open={false} label={tg("orgCanvas.more")} onToggle={() => undefined} />
          </OrgNode>
          <OrgNode level="dept" box={at(312, 232, 192, 56)} states={["ok"]}>
            <NodeRow name={tg("orgCanvas.dept2")} />
          </OrgNode>
          <OrgNode level="dept" box={at(560, 232, 192, 56)} states={["dim"]}>
            <NodeRow name={tg("orgCanvas.dept3")} />
          </OrgNode>
        </OrgCanvas>
      </div>
      <ActionMenu
        label={tg("orgCanvas.menu")}
        trigger={tg("orgCanvas.menu")}
        actions={[
          { id: "r", label: tg("orgCanvas.rename"), shortcut: "F2", onAction: () => undefined },
          { id: "m", label: tg("orgCanvas.move"), shortcut: "M", onAction: () => undefined },
          { id: "d", label: tg("orgCanvas.delete"), shortcut: "Del", danger: true, onAction: () => undefined },
        ]}
      />
    </section>
  );
}
