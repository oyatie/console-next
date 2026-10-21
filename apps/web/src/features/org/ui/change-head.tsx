import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { ORG_CHANGE_STATUS, actor, labeled } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { daysBetween } from "../../../ui/date/days";
import { changeQuery } from "../api";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];

/** The record's head: back to the list, the change as a phrase (the focus target), its code and status, and when it applies. */
export function ChangeHead({ d, title, today }: { d: Detail; title: string; today: string }) {
  const status = labeled(ORG_CHANGE_STATUS, d.status);
  const days = daysBetween(today, d.effectiveDate);
  const rel = days >= 0 ? t("orgChange.rel.ahead", { days }) : t("orgChange.rel.ago", { days: -days });
  const prev = useQuery({ ...changeQuery(d.supersedesId ?? ""), enabled: !!d.supersedesId });
  return (
    <header className={css.head}>
      <Link to="/org/changes" search={{}} className={css.back}>{t("orgChange.back")}</Link>
      <div className="row">
        <h1 id="change-title" className="page__title" tabIndex={-1}>{title}</h1>
        <span className="code">{d.code}</span>
        <Chip tone={status.tone}>{status.label}</Chip>
      </div>
      <p className={css.sub}>
        <span className="num">{t("orgChange.sub", { date: fmtDate(d.effectiveDate), rel, drafter: actor(d.draftedByName), at: fmtDateTime(d.createdAt) })}</span>
        {d.supersedesId && prev.data && (
          <Link to="/org/changes/$id" params={{ id: d.supersedesId }}>{t("orgChange.supersedes", { code: prev.data.code })}</Link>
        )}
      </p>
    </header>
  );
}
