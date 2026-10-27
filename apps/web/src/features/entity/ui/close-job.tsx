import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Banner } from "../../../ui/banner/banner";
import { Chip } from "../../../ui/chip";
import { WORKPLACE_CLOSE_STATE } from "../../../lib/labels";
import type { CloseJob, ClosePlanView } from "../../../reference/close/api";
import { jobCounts } from "../../../reference/close/domain/plan";
import { subjectName, whyText } from "../../../reference/close/present";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * The close job: the receipt after planning and what a reopened sheet shows while one is open (SCHEDULED, or WAITING
 * for the exit it opened or the group transfer it recorded). Says what it will do or did, who is still waited for (with the
 * exits list and the group transfers), and why a failed one applied nothing.
 */
export function CloseJobPanel({ job, view }: { job: CloseJob; view: ClosePlanView }) {
  const date = fmtDate(job.closed_on);
  const waiting = job.lines.filter((l) => l.action === "EXIT" && !l.done);
  const groups = job.lines.filter((l) => l.action === "GROUP_TRANSFER" && !l.done);
  const failed = ((job.failure as { refusals?: { employee_id?: string; org_unit_id?: string; code?: string }[] } | null)?.refusals ?? []);
  return (
    <section className={css.stack} aria-labelledby="close-job" role="status">
      <h3 id="close-job" className={css.secH}>
        <Chip tone={WORKPLACE_CLOSE_STATE.tone?.[job.state]}>{t(`workplace.close.job.${job.state}`, { date })}</Chip>
      </h3>
      <p>{t("workplace.close.job.lines", jobCounts(job.lines))}</p>
      {(job.state === "WAITING" || job.state === "SCHEDULED") && waiting.length > 0 && (
        <>
          <p className="row">
            {t("workplace.close.job.waitingOn", { count: waiting.length })}
            <Link to="/people/exits" search={{ status: "open" }}>{t("workplace.close.job.exits")}</Link>
          </p>
          {/* move-29, company-34: each closure exit this close opened, by name, linked to its exit case. */}
          <ul className={css.list} aria-label={t("workplace.close.job.waitingList")}>
            {waiting.slice(0, 50).map((l) => (
              <li key={l.employee_id ?? l.exit_case_id}>
                {l.exit_case_id ? <Link to="/people/exits/$id" params={{ id: l.exit_case_id }}>{subjectName(view, l)}</Link> : subjectName(view, l)}
              </li>
            ))}
          </ul>
        </>
      )}
      {(job.state === "WAITING" || job.state === "SCHEDULED") && groups.length > 0 && (
        <>
          <p>{t("workplace.close.job.groupWaiting", { count: groups.length })}</p>
          {/* Each group transfer this close recorded, by name, linked to the sending entity's settlement it opened. */}
          <ul className={css.list}>
            {groups.slice(0, 50).map((l) => (
              <li key={l.employee_id ?? l.lifecycle_event_id}>
                {l.exit_case_id ? <Link to="/people/exits/$id" params={{ id: l.exit_case_id }}>{subjectName(view, l)}</Link> : subjectName(view, l)}
              </li>
            ))}
          </ul>
        </>
      )}
      {job.state === "FAILED" && (
        <Banner tone="danger">
          <p>{t("workplace.close.job.failure", { count: failed.length })}</p>
          <ul className={css.list}>
            {failed.map((r) => <li key={`${r.employee_id ?? r.org_unit_id}`}>{t("workplace.close.refusedLine", { who: subjectName(view, r), why: whyText(r.code ?? "") })}</li>)}
          </ul>
        </Banner>
      )}
    </section>
  );
}
