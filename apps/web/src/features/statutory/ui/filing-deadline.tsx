import { ExternalLink } from "../../../ui/external-link";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { FilingDeadline } from "../../../reference/statutory/ui/filing-deadline";
import type { FilingCitation, FilingTask } from "../../../reference/statutory/api";
import { filingLabel } from "../present";
import s from "./statutory.module.css";
import { buttonClass } from "../../../ui/button/button-class";
const Citation = ({ value }: { value: FilingCitation }) => <dl className="facts"><dt><ExternalLink className={buttonClass("ghost", { size: "sm", className: s.citation })} href={value.source_url}>{value.instrument} · {value.article}</ExternalLink></dt><dd>{value.promulgation} · {fmtDate(value.enforced_on)}</dd></dl>;
/** A filing's window opens at the earliest day; the legal deadline and its basis come from the register. */
export function FilingWindow({ task }: { task: FilingTask }) {
  const penalty = task.basis?.penalty;
  return <div className={s.filingWindow}>
    {task.opens_in_days != null && task.opens_in_days > 0 && <Chip>{t("statutory.preparing")}</Chip>}
    <div className="row">
      {task.opens_on && <div className={s.dateGroup}>{t("statutory.opens")} <time dateTime={task.opens_on}>{fmtDate(task.opens_on)}</time></div>}
      <div className={s.dateGroup}>{t("statutory.deadline")} <FilingDeadline task={task} review={false} /></div>
    </div>
    {!task.basis && task.deadline_status === "HOLD" && <p>{t("statutory.hold")}</p>}
    {!task.basis && task.dates?.conservative && <p>{t("statutory.conservative")}</p>}
    {task.basis && <details><summary className={buttonClass("ghost", { size: "sm", className: s.basis })}>{t("statutory.basis")}</summary>
      {task.deadline_status === "HOLD" && <p>{t("statutory.hold")}</p>}
      {task.dates?.conservative && <p>{t("statutory.conservative")}</p>}
      <Citation value={task.basis.citation} />
      {task.basis.applicability_citations?.map((c) => <Citation key={c.source_url} value={c} />)}
      {task.dates?.legal_latest_candidate && <dl className="facts"><dt>{t("statutory.candidateLabel")}</dt><dd><time dateTime={task.dates.legal_latest_candidate}>{fmtDate(task.dates.legal_latest_candidate)}</time></dd></dl>}
      <p>{t("statutory.openingHold")}</p>
      {task.basis.covered_by && <dl className="facts"><dt>{filingLabel(task.basis.covered_by)}</dt><dd>{t("statutory.coverageRule")}</dd></dl>}
      {!penalty && <p>{t("statutory.penaltyPending")}</p>}
      {penalty && <div><dl className="facts"><dt>{t("statutory.penalty")}</dt><dd> {penalty.per_worker && t("statutory.perWorker")} {penalty.delay_won.map((amount) => t("statutory.won", { amount })).join(" / ")} {penalty.cap_won !== null && t("statutory.cap", { amount: fmtNumber(penalty.cap_won) })}</dd></dl><Citation value={penalty.citation} /></div>}
    </details>}
  </div>;
}
