import { ExternalLink } from "../../../ui/external-link";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { FilingDeadline } from "../../../reference/statutory/ui/filing-deadline";
import type { FilingCitation, FilingTask } from "../../../reference/statutory/api";
import { filingLabel } from "../present";
const Citation = ({ value }: { value: FilingCitation }) => <dl className="facts"><dt><ExternalLink href={value.source_url}>{value.instrument} · {value.article}</ExternalLink></dt><dd>{value.promulgation} · {fmtDate(value.enforced_on)}</dd></dl>;
/** A filing's window opens at the earliest day; the legal deadline and its basis come from the register. */
export function FilingWindow({ task }: { task: FilingTask }) {
  const penalty = task.basis?.penalty;
  return <div className="form">
    {task.opens_in_days != null && task.opens_in_days > 0 && <Chip>{t("statutory.preparing")}</Chip>}
    <div className="row">
      {task.opens_on && <>{t("statutory.opens")} <time dateTime={task.opens_on}>{fmtDate(task.opens_on)}</time> · </>}
      {t("statutory.deadline")} <FilingDeadline task={task} />
    </div>
    {task.dates?.conservative && <Chip tone="warn">{t("statutory.conservative")}</Chip>}
    {task.basis && <details><summary>{t("statutory.basis")}</summary>
      <Citation value={task.basis.citation} />
      {task.basis.applicability_citations?.map((c) => <Citation key={c.source_url} value={c} />)}
      {task.dates?.legal_latest_candidate && <dl className="facts"><dt>{t("statutory.candidateLabel")}</dt><dd><time dateTime={task.dates.legal_latest_candidate}>{fmtDate(task.dates.legal_latest_candidate)}</time></dd></dl>}
      <Chip tone="warn">{t("statutory.openingHold")}</Chip>
      {task.basis.covered_by && <dl className="facts"><dt>{filingLabel(task.basis.covered_by)}</dt><dd>{t("statutory.coverageRule")}</dd></dl>}
      {!penalty && <Chip tone="warn">{t("statutory.penaltyPending")}</Chip>}
      {penalty && <div><dl className="facts"><dt>{t("statutory.penalty")}</dt><dd> {penalty.per_worker && t("statutory.perWorker")} {penalty.delay_won.map((amount) => t("statutory.won", { amount })).join(" / ")} {penalty.cap_won !== null && t("statutory.cap", { amount: fmtNumber(penalty.cap_won) })}</dd></dl><Citation value={penalty.citation} /></div>}
    </details>}
  </div>;
}
