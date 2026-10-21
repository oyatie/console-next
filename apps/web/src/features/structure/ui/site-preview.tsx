import { t } from "@console/i18n";
import { place } from "../../../ui/org-canvas/place";
import { freeAt, type Box, type Layout } from "../domain/layout";
import { pathTo, type ChartNode, type Structure } from "../domain/model";
import css from "./chart.module.css";

const W = 420;
const ROW = 22;
const MAX = 8;
/** The departments sit three to a row (S2-chart-scale), so the card fits the band above the legal entity row. */
const COLS = 3;

/**
 * A card about a compact workplace, opened in the nearest empty area: the band above the entity row first (so it never
 * covers another entity's header or tiles, with a leader down to the tile), then beside the tile's column, then below it.
 */
function PreviewCard({ L, box, h, label, children }: { L: Layout; box: Box; h: number; label?: string; children: React.ReactNode }) {
  const band = Math.min(...L.boxes.filter((b) => b.node.kind === "entity").map((b) => b.y)) - h - 24;
  const centred = Math.min(Math.max(8, box.x + box.w / 2 - W / 2), L.w - W - 8);
  const spots: [number, number][] = [[centred, band], [box.x + box.w + 24, box.y], [box.x - W - 24, box.y], [centred, box.y + box.h + 24]];
  // Never above the stage's top edge: the canvas's top band covers that.
  const [left, top] = spots.find(([x, y]) => y >= 0 && freeAt(L, x, y, W, h, box)) ?? spots[0]!;
  return (
    <>
      {top < box.y && (
        <svg className={css.leader} width={L.w} height={L.h} aria-hidden>
          <path d={`M${box.x + box.w / 2} ${top + h} V${box.y}`} />
        </svg>
      )}
      <div className={`${css.preview} card`} ref={place({ left, top, width: W })} role={label ? "status" : "tooltip"} aria-label={label}>
        {children}
      </div>
    </>
  );
}

/**
 * The hover preview of a compact workplace (spec S2-chart-scale): its departments and counts. Enter (or F) on the tile
 * opens that workplace in full.
 */
export function SitePreview({ L, box }: { L: Layout; box: Box }) {
  const n = box.node;
  const rows = n.children.slice(0, MAX);
  // Its title, list and keys line inside the card's padding (an estimate short of the drawn card let it cover the row below).
  const h = 84 + Math.max(1, Math.ceil(rows.length / COLS)) * ROW + (n.children.length > MAX ? ROW : 0);
  return (
    <PreviewCard L={L} box={box} h={h}>
      <strong>{n.name}</strong>
      <span className="muted"> {t("common.headcount", { count: n.headcount })}</span>
      <ul className={`${css.previewList} ${css.previewGrid}`}>
        {rows.map((d) => <li key={d.id}><span>{d.name}</span><span className="num">{t("common.headcount", { count: d.headcount })}</span></li>)}
        {rows.length === 0 && <li className="muted">{t("structure.preview.none")}</li>}
        {n.children.length > MAX && <li className="muted">{t("structure.preview.more", { count: n.children.length - MAX })}</li>}
      </ul>
      <span className="muted">{t("structure.preview.keys")}</span>
    </PreviewCard>
  );
}

/**
 * The find's current result when the chart does not draw it (inside a compact workplace, S2-chart-scale-search): where
 * it sits, its name, head and code, beside the tile marked "now".
 */
export function HitPreview({ s, L, box, hit, at, total }: { s: Structure; L: Layout; box: Box; hit: ChartNode; at: number; total: number }) {
  const path = pathTo(s, hit.id).slice(1, -1).map((n) => n.name).join(" › ");
  const line = [hit.kind === "dept" && (hit.head ? t("structure.node.head", { name: hit.head.name, concurrent: hit.head.concurrent ? "yes" : "no" }) : t("structure.node.headVacant")), hit.code].filter(Boolean).join(" · ");
  return (
    <PreviewCard L={L} box={box} h={150} label={t("structure.find.label")}>
      <strong>{t("structure.find.now")} · {t("structureChart.find.at", { at, total })}</strong>
      <span className="muted">{path}</span>
      <span className={css.previewHit}><b>{hit.name}</b><span className="num">{t("common.headcount", { count: hit.headcount })}</span></span>
      {line && <span className="muted">{line}</span>}
      <span className="muted">{t("structure.find.keys")}</span>
    </PreviewCard>
  );
}
