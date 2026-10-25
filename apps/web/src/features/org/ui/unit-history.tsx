import { Link } from "@tanstack/react-router";
import { changeTitle } from "../present";
import { OutcomeLink } from "../../../lib/react/outcome-link";
import { ActorBadge } from "../../../ui/timeline-lanes/actor-badge";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { actor } from "../../../lib/labels";
import { historyLines } from "../domain/tree";
import css from "./unit-history.module.css";

type Unit = components["schemas"]["OrgUnitHead"];
type Change = components["schemas"]["OrgChangeSummary"];
type Revision = components["schemas"]["OrgUnitRevision"];

/** What happened to the unit, one line per change (diffed revision to revision), collapsed unless asked open. */
export function UnitHistory({ revisions, units, open, scheduled = [] }: { revisions: Revision[]; units: Unit[]; open: boolean; scheduled?: Change[] }) {
  const names = new Map(units.map((u) => [u.id, u.name]));
  const parentName = (id: string | null) => (id ? names.get(id) ?? "—" : "—");
  const lines = historyLines(revisions);
  const future = [...scheduled].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.createdAt.localeCompare(b.createdAt));
  const lookup = { unit: (id?: string | null) => id ? names.get(id) : undefined, region: () => undefined, branch: () => undefined };
  return (
    <details className={css.section} open={open}>
      <summary className={css.summary}>{t("orgTree.history.title", { count: lines.length + future.length })}</summary>
      <ol className="list-plain">
        {future.map((c) => <li key={c.id} className={css.historyLine}>
          <Link to="/org/changes/$id" params={{ id: c.id }}><Chip tone="info">{t("orgChange.timeline.scheduled")}</Chip> {c.applies_at ? fmtDateTime(c.applies_at) : fmtDate(c.effectiveDate)} · {c.code} · {changeTitle(c, lookup)}</Link>
          <span className={css.meta}>{actor(c.draftedByName)}</span>
        </li>)}
        {lines.map((l, i) => {
          const date = fmtDate(l.date);
          const what =
            l.kind === "created" ? t("orgTree.history.created", { date, name: l.name })
            : l.kind === "renamed" ? t("orgTree.history.renamed", { date, from: l.from, to: l.to })
            : l.kind === "moved" ? t("orgTree.history.moved", { date, from: parentName(l.from), to: parentName(l.to) })
            : l.kind === "code" ? t("orgTree.history.code", { date, from: l.from ?? t("orgTree.history.none"), to: l.to ?? t("orgTree.history.none") })
            : l.kind === "head" ? t("orgTree.history.head", { date, from: l.from ?? t("orgTree.history.vacant"), to: l.to ?? t("orgTree.history.vacant") })
            : l.kind === "merged" ? t("orgTree.history.merged", { date, into: parentName(l.into) })
            : t("orgTree.history.dissolved", { date });
          return (
            <li key={i} className={css.historyLine}>
              <span>{what}</span>
              <span className={css.meta}>{t("orgTree.history.meta", { actor: actor(l.actor), at: fmtDateTime(l.at) })}<ActorBadge kind={l.actorKind} /><OutcomeLink id={l.commandId} /></span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
