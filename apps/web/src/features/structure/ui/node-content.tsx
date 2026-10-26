import { EntityName } from "../../../reference/entity/ui/entity-name";
import type { ReactNode } from "react";
import { Building2, MapPin } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { NodeChips, NodeFoot, NodeKicker, NodeLine, NodeRow } from "../../../ui/org-canvas/org-node";
import type { Box } from "../domain/layout";
import { kindWord, nodeName, unitCounts } from "../present";
import { deptCount, type ChartNode, type Chip as ChipCode } from "../domain/model";

const people = (count: number) => t("common.headcount", { count });
const CHIP_TONE: Record<ChipCode, "warn" | "neutral" | "info"> = { registration_missing: "warn", needs_confirmation: "warn", unverified: "warn", suspended: "neutral", closed: "neutral" };
// One vocabulary (company-25): a closed workplace reads "closed", a closed legal entity "ended" (a registration keeps its own status).
const chipText = (n: ChartNode, c: ChipCode) => (c === "closed" && n.kind === "entity" ? t("structure.chip.closedEntity") : t(`structure.chip.${c}`));
// company-25: the server marks no legal entity closed yet (ENTITY ask); its primary workplace closes only with it
// (workplace_holds_entity_role), so a closed primary workplace is the legal entity's end.
const ended = (n: ChartNode) => n.kind === "entity" && !n.chips.includes("closed") && n.children.some((c) => c.primary && c.chips.includes("closed"));
const chipsOf = (n: ChartNode): readonly ChipCode[] => (ended(n) ? [...n.chips, "closed"] : n.chips);
const chips = (n: ChartNode) => chipsOf(n).map((c) => <Chip key={c} tone={CHIP_TONE[c]}>{chipText(n, c)}</Chip>);
/** People in a legal entity placed at no workplace yet: they count in its total, and the box says so (S2). */
const unplaced = (n: ChartNode) => n.unplaced != null && <Chip tone="warn">{t("structureChart.unplaced", { count: n.unplaced })}</Chip>;

/** The lines a box shows at its level of detail (D3: content drops, type size never does). */
export function NodeContent({ box, counts, badge }: {
  box: Box;
  counts: { entities: number; sites: number; depts: number };
  /** Drawn beside the name (a closed box's count of find hits inside). */
  badge?: ReactNode;
}) {
  const n = box.node;
  // The root: a header over the legal entities row, never a company box (decision #29). The phase is in the page head.
  if (n.kind === "tenant")
    return (
      <>
        <NodeRow name={nodeName(n)} count={people(n.headcount)} />
        <NodeFoot>{t("structure.node.tenantCounts", counts)}{n.unplaced != null && <Chip tone="warn">{t("structureChart.entityUnknown", { count: n.unplaced })}</Chip>}</NodeFoot>
      </>
    );
  if (n.kind === "entity") {
    const sites = n.children.length;
    if (box.lod !== "full")
      return (
        <>
          <NodeRow name={<EntityName name={n.name} alias={n.alias} />} count={people(n.headcount)} small>{badge}</NodeRow>
          <NodeFoot>{t("structure.node.entityCounts", { sites, depts: deptCount(n) })}{unplaced(n)}{chipsOf(n).includes("closed") && <Chip tone="neutral">{t("structure.chip.closedEntity")}</Chip>}</NodeFoot>
        </>
      );
    return (
      <>
        <NodeKicker icon={<Building2 size={14} aria-hidden />}>{n.brn ? t("structure.node.entityKicker", { brn: n.brn }) : t("structure.level.entity")}</NodeKicker>
        <NodeRow name={<EntityName name={n.name} alias={n.alias} />} count={people(n.headcount)} />
        <NodeLine>{n.reps ? t("structure.node.reps", { name: n.reps.first, more: n.reps.more }) : " "}</NodeLine>
        <NodeFoot>{t("structure.node.entityCounts", { sites, depts: deptCount(n) })}</NodeFoot>
        {(chipsOf(n).length > 0 || n.unplaced != null) && <NodeChips>{unplaced(n)}{chips(n)}</NodeChips>}
      </>
    );
  }
  if (n.kind === "site") {
    if (box.lod === "xs" || box.lod === "tile")
      return (
        <>
          <NodeRow name={n.name} small count={box.lod === "xs" ? fmtNumber(n.headcount) : undefined}>{badge}</NodeRow>
          {box.lod === "tile" && <NodeFoot><b>{fmtNumber(n.headcount)}</b>{t("structure.node.tileFoot", { depts: deptCount(n) })}</NodeFoot>}
        </>
      );
    const flags = [n.headOffice && t("structure.node.headOffice"), n.primary && t("structure.node.primary")].filter((x): x is string => Boolean(x));
    const foot = unitCounts(n);
    if (box.lod === "m")
      return (
        <>
          <NodeRow name={n.name} count={people(n.headcount)}>{badge}</NodeRow>
          <NodeFoot>{flags.map((f) => <Chip key={f}>{f}</Chip>)}{foot}</NodeFoot>
          {n.chips.length > 0 && <NodeChips>{chips(n)}</NodeChips>}
        </>
      );
    return (
      <>
        <NodeKicker icon={<MapPin size={14} aria-hidden />}>{n.area || kindWord(n) ? t("structure.node.siteKicker", { area: [kindWord(n), n.area].filter(Boolean).join(" · ") }) : t("structure.level.site")}</NodeKicker>
        <NodeRow name={n.name}>{flags.map((f) => <Chip key={f}>{f}</Chip>)}{badge}</NodeRow>
        <NodeFoot>{foot}</NodeFoot>
        {n.chips.length > 0 && <NodeChips>{chips(n)}</NodeChips>}
      </>
    );
  }
  // Its head on the second line (S2); a department in the focus's row has room for its code and counts too.
  const head = n.head ? t("structure.node.head", { name: n.head.name, concurrent: n.head.concurrent ? "yes" : "no" }) : <Chip tone="warn">{t("structure.head.missing")}</Chip>;
  return (
    <>
      <NodeRow name={n.name} count={people(n.headcount)}>{badge}</NodeRow>
      <NodeLine>{head}</NodeLine>
      {box.lod === "full" && <NodeFoot>{n.code && <>{n.code}{" · "}</>}{unitCounts(n)}</NodeFoot>}
    </>
  );
}
