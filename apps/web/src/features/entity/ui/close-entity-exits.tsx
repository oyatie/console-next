import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { retirementDate } from "../../people/domain/employment";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { refusalText } from "../../../reference/crud/present";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { CLOSE_READS, entityEndQuery, entityPeopleQuery, reportCloseExits } from "../../../reference/close/api";
import { settleBy } from "../../../reference/close/domain/plan";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * Closing a legal entity that still employs people (company-18): they all leave first, and this opens their exits here,
 * filtered to this entity, with one last working day and the reason (business closure or insolvency) — no trip to the
 * unfiltered roster. Each exit then goes the usual way (its confirmation and final settlement).
 */
export function EntityExits({ entityId, count }: { entityId: string; count: number }) {
  const q = useQuery(entityPeopleQuery(entityId));
  const [date, setDate] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const people = (q.data?.items ?? []).map((e) => ({ id: e.id, name: e.name }));
  const run = useCommand({
    run: () => reportCloseExits(people, { date, reason: reason!, note: t("entityRecordClose.exits.note") }, keys.current),
    invalidates: CLOSE_READS,
  });
  // Drawn at once with the count the record already holds, so the people read landing moves nothing (layout shift).
  if (q.isSuccess && !people.length) return null;
  const ready = Boolean(date && reason && q.isSuccess);
  const label = t("entityRecordClose.exits.submit", { count: q.isSuccess ? people.length : count });
  const rows = run.data;
  return (
    <section className={css.stack} aria-label={t("entityRecordClose.peopleFix")}>
      <DateField label={t("entityRecordClose.exits.lastDay")} required value={date} onChange={setDate} today={todayKst()} />
      <ChoiceField
        label={t("entityRecordClose.exits.reason")}
        required
        options={[{ value: "CLOSURE", label: t("entityRecordClose.exits.closure") }, { value: "INSOLVENCY", label: t("entityRecordClose.exits.insolvency") }]}
        value={reason}
        onChange={setReason}
      />
      {/* A row keeps the canonical button its own width (company-14: the stack stretched it to a full-width bar). */}
      <div className="row">
        {ready ? (
          <Button onClick={() => run.mutate(undefined)} disabled={run.isPending}>{label}</Button>
        ) : (
          <DisabledReason control={(p) => <Button {...p}>{label}</Button>} reason={t("entityRecordClose.exits.need")} />
        )}
      </div>
      <CommandError error={run.error} />
      {rows && (
        <div role="status" className={css.stack}>
          <span>{t("entityRecordClose.exits.done", { ok: rows.filter((r) => !r.code).length, refused: rows.filter((r) => r.code).length })}</span>
          <ul className={css.list}>
            {rows.filter((r) => r.code).map((r) => <li key={r.id}>{t("entityRecordClose.exits.refused", { name: r.name, why: refusalText(r.code) ?? r.code ?? "" })}</li>)}
          </ul>
          <Link to="/people/exits" search={{ status: "open" }} className={buttonClass("ghost", { size: "sm" })}>{t("entityRecordClose.exits.list")}</Link>
        </div>
      )}
    </section>
  );
}

/** The exits still open for anyone placed at this legal entity, each with its final-settlement deadline (company-52). */
export function OpenEntityExits({ entityId }: { entityId: string }) {
  const q = useQuery(entityEndQuery(entityId));
  const cases = q.data?.open_exit_cases ?? [];
  if (!cases.length) return null;
  return (
    <section className={css.stack} aria-labelledby="entity-open-exits">
      <h3 id="entity-open-exits" className={css.secH}>{t("entityRecordClose.cases", { count: cases.length })}</h3>
      <ul className={css.list}>
        {cases.map((c) => (
          <li key={c.case_id}>
            <Link to="/people/exits/$id" params={{ id: c.case_id }} className={buttonClass("ghost", { size: "sm" })}>
              {t("entityRecordClose.case", { name: c.employee_name, date: fmtDate(retirementDate(c.effective_exit_date)), due: fmtDate(settleBy(c.effective_exit_date)) })}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
