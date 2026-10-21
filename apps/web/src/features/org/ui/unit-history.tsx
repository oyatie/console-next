import { OutcomeLink } from "../../../lib/react/outcome-link";
import { ActorBadge } from "../../../ui/timeline-lanes/actor-badge";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { actor } from "../../../lib/labels";
import { historyLines } from "../domain/tree";
import css from "./unit-history.module.css";

type Unit = components["schemas"]["OrgUnitHead"];
type Revision = components["schemas"]["OrgUnitRevision"];

/** What happened to the unit, one line per change (diffed revision to revision), collapsed unless asked open. */
export function UnitHistory({ revisions, units, open }: { revisions: Revision[]; units: Unit[]; open: boolean }) {
  const names = new Map(units.map((u) => [u.id, u.name]));
  const parentName = (id: string | null) => (id ? names.get(id) ?? "—" : "—");
  const lines = historyLines(revisions);
  return (
    <details className={css.section} open={open}>
      <summary className={css.summary}>{t("orgTree.history.title", { count: lines.length })}</summary>
      <ol className="list-plain">
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
