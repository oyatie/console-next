import { useId, type ReactNode } from "react";
import { t } from "@console/i18n";
import { label, UNIT_KIND } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import type { PreviewNode } from "../domain/preview";
import s from "./propose.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * Before and after a structural change (StructureDiff). The sentence comes first and says the change in
 * words; the two mini trees show it with roll-up headcounts, the changed node marked in text. A preview
 * from today's tree, which the caption says.
 */
export function StructureDiff({ summary, before, after, then, note }: {
  summary: string;
  before: PreviewNode[];
  after: PreviewNode[];
  /** The after column's heading, e.g. "From Nov 2" or "Once archived". */
  then: string;
  note?: ReactNode;
}) {
  return (
    <div className={s.diff}>
      <p className={s.diffSummary}>{summary}</p>
      <div className={s.diffCols}>
        <Column title={t("orgPropose.diff.now")} nodes={before} />
        <Column title={then} nodes={after} />
      </div>
      {note != null && <p className={s.note}>{note}</p>}
    </div>
  );
}

function Column({ title, nodes }: { title: string; nodes: PreviewNode[] }) {
  const id = useId();
  return (
    <div className={s.diffCol}>
      <h4 id={id} className={s.diffTitle}>{title}</h4>
      <ul className={s.diffTree} aria-labelledby={id}>
        {nodes.map((n) => <Node key={n.id} n={n} />)}
      </ul>
    </div>
  );
}

function Node({ n }: { n: PreviewNode }) {
  return (
    <li>
      <span className={s.diffRow} data-mark={n.mark ?? (n.delta ? "delta" : undefined)}>
        {/* The root unit shows as "All" alone, never the account's name (decision #29). */}
        <span className={s.diffName}>{n.kind === "COMPANY" ? label(UNIT_KIND, n.kind) : n.mark === "created" && !n.name.trim() ? t("orgPropose.diff.unnamed", { kind: label(UNIT_KIND, n.kind) }) : n.name}</span>
        {n.kind !== "COMPANY" && <Muted>{label(UNIT_KIND, n.kind)}</Muted>}
        <span className="num muted">{t("orgPropose.diff.count", { count: n.count })}</span>
        {n.mark && <Chip tone={n.mark === "dissolved" ? "warn" : "info"}>{t(`orgPropose.diff.chip.${n.mark}`)}</Chip>}
        {n.delta ? <Chip tone="info">{t(n.delta > 0 ? "orgPropose.diff.chip.plus" : "orgPropose.diff.chip.minus", { count: Math.abs(n.delta) })}</Chip> : null}
      </span>
      {n.children.length > 0 && <ul>{n.children.map((c) => <Node key={c.id} n={c} />)}</ul>}
    </li>
  );
}

/** A region or branch change has no tree: one line before and after. */
export function LineDiff({ before, after, then }: { before: string; after: string; then: string }) {
  return (
    <dl className="kv">
      <dt>{t("orgPropose.diff.now")}</dt>
      <dd>{before}</dd>
      <dt>{then}</dt>
      <dd>{after}</dd>
    </dl>
  );
}
