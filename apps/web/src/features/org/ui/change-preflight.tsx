import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { ORG_CHANGE_STATUS, labeled } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { changeQuery, changesByStatusQuery, changeUnitId, OPEN_CHANGE_STATUSES } from "../api";
import css from "./org-change.module.css";
import { Muted } from "../../../ui/muted/muted";

type Detail = components["schemas"]["OrgChangeDetail"];
type Report = components["schemas"]["OrgChangePreflightReport"];

/**
 * The live preflight of a draft: blockers first, each with the server's label, its code and the fix this
 * screen can offer. The footer holds the only affected-people number shown while the change is a draft (D3).
 */
export function ChangePreflight({ d, report, checking, onRerun, onEdit }: {
  d: Detail;
  report: Report;
  checking: boolean;
  onRerun: () => void;
  onEdit: () => void;
}) {
  return (
    <section className="card panel" aria-labelledby="preflight" aria-busy={checking || undefined}>
      <div className="row">
        <h2 id="preflight" className="panel__title" tabIndex={-1}>{t("orgChange.preflight")}</h2>
        {report.blockers.length > 0 && <Chip tone="danger">{t("orgChange.preflight.blocked", { count: report.blockers.length })}</Chip>}
        {report.warnings.length > 0 && <Chip tone="warn">{t("orgChange.preflight.warn", { count: report.warnings.length })}</Chip>}
        {report.blockers.length === 0 && <Chip tone="ok">{t("orgChange.preflight.clear")}</Chip>}
        <span className="muted num">{checking ? t("orgChange.preflight.rerunning") : t("orgChange.preflight.at", { at: fmtDateTime(report.computedAt) })}</span>
        <Button variant="ghost" disabled={checking} onClick={onRerun}>{t("orgChange.preflight.rerun")}</Button>
      </div>
      <ul className="list-plain">
        {report.blockers.map((b) => (
          <li key={b.code} className={css.check}>
            <span className="row">
              <Chip tone="danger">{b.label}</Chip>
              <span className="muted num">{b.dependentKind} · {b.count}</span>
              <code className="code">{b.code}</code>
            </span>
            <Fix d={d} code={b.code} count={b.count} onEdit={onEdit} />
          </li>
        ))}
        {report.warnings.map((w) => (
          <li key={w.code} className={css.check}>
            <span className="row">
              <Chip tone="warn">{w.label}</Chip>
              {w.dependentKind && <span className="muted num">{w.dependentKind} · {w.count}</span>}
              <code className="code">{w.code}</code>
            </span>
            <Fix d={d} code={w.code} count={w.count ?? 0} onEdit={onEdit} />
          </li>
        ))}
      </ul>
      <p className="muted num">{t("orgChange.preflight.footer", { count: report.headcount, deps: report.dependentsTotal })}</p>
    </section>
  );
}

/** The fix this screen knows for a code; any other code shows its label and count only. */
function Fix({ d, code, count, onEdit }: { d: Detail; code: string; count: number; onEdit: () => void }) {
  const unit = changeUnitId(d);
  if (code === "ORG_UNIT_ACTIVE_MEMBERS" && unit) return <MoveMembersFix d={d} unit={unit} count={count} />;
  if (code === "ORG_UNIT_ACTIVE_CHILDREN" && unit)
    return <Link to="/org" search={{ sel: unit }} className="btn">{t("orgChange.preflight.fix.children")}</Link>;
  if (code === "FREEZE_WINDOW_REVIEW") return <Button onClick={onEdit}>{t("orgChange.edit")}</Button>;
  return null;
}

/**
 * Members block a dissolution until a separate member move is approved and applied. While one is open for the
 * unit, it is named instead of a second fix (one move at a time).
 * the open list is one page of 200; a server `target` filter replaces it (§9).
 */
function MoveMembersFix({ d, unit, count }: { d: Detail; unit: string; count: number }) {
  const open = useQuery(changesByStatusQuery(OPEN_CHANGE_STATUSES, { limit: 200 }));
  const candidates = (open.data?.items ?? []).filter((c) => c.id !== d.id && c.kind === "REORG" && c.target.kind === "ORG_UNIT" && c.target.ref === unit);
  const details = useQueries({ queries: candidates.map((c) => changeQuery(c.id)) });
  const moving = details.map((q) => q.data).find((x) => x?.proposal.some((op) => op.op === "REASSIGN_ORG_UNIT" && op.fromOrgUnit === unit));
  if (moving)
    return (
      <Link to="/org/changes/$id" params={{ id: moving.id }}>
        {t("orgChange.preflight.fix.open", { code: moving.code, status: labeled(ORG_CHANGE_STATUS, moving.status).label, date: fmtDate(moving.effectiveDate) })}
      </Link>
    );
  return (
    <span className={css.fix}>
      <span className="row">
        <Link to="/org" search={{ sel: unit, act: "reassign" }} className="btn">{t("orgChange.preflight.fix.members", { count })}</Link>
        <Link to="/people" search={{ unit }}>{t("orgChange.preflight.fix.split")}</Link>
      </span>
      <Muted>{t("orgChange.preflight.fix.membersNote")}</Muted>
    </span>
  );
}
