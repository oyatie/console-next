import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { KeyValue } from "../../../ui/key-value/key-value";
import { FilingDeadline } from "../../../reference/statutory/ui/filing-deadline";
import s from "./exit.module.css";
import { LifecycleTrail } from "./lifecycle-trail";

type Deadline = components["schemas"]["ExitSettlementDeadline"];

/**
 * What the leaving employer settles and by when (decision #30: every event tracks its deadlines): the final settlement and the
 * severance payment, each payable from the day after the last working day, with the legal deadline from the statutory register as
 * D-n, its review state and the article it rests on. The server computes every date; a missing register row shows as unknown.
 */
export function ExitDeadlines({ deadlines, employeeId, exitCaseId }: { deadlines: readonly Deadline[] | undefined; employeeId?: string; exitCaseId?: string }) {
  if (employeeId && exitCaseId) return <LifecycleTrail employeeId={employeeId} exitCaseId={exitCaseId} />;
  if (!deadlines?.length) return null;
  const note = (d: Deadline) =>
    [d.opens_on && t("exit.deadline.opens", { date: fmtDate(d.opens_on) }), d.instrument && t("exit.deadline.basis", { instrument: d.instrument, article: d.article ?? "" })]
      .filter(Boolean)
      .join(" · ");
  return (
    <section aria-labelledby="exit-deadlines">
      <h3 id="exit-deadlines" className={s.groupTitle}>{t("exit.deadlines")}</h3>
      <KeyValue
        label={t("exit.deadlines")}
        items={deadlines.map((d) => ({
          key: d.kind,
          label: t(`exit.deadline.${d.kind}`),
          value: (
            <>
              <FilingDeadline task={d} />
              {note(d)}
            </>
          ),
        }))}
      />
    </section>
  );
}
