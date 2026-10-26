import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime, fmtNumber } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, ID_TYPE, PAY_UNIT, PROBATION_STATE, WORKER_CLASS, label, labeled } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import type { Facts } from "../domain/facts";
import { confirmProbation, factsQuery } from "../api";
import { FactsForm } from "./facts-form";
import { Muted } from "../../../ui/muted/muted";
import { maskedBirth } from "../domain/card";
import { FieldValue } from "./field-value";

type Employee = components["schemas"]["Employee"];

/**
 * The employment record (EMP-MODEL E3, E4, E5, E12, E13, F5): birth date, work email, the ID document's type (never
 * its number), employment type with its worker classification, base pay with its unit, and probation with the
 * server's clock. Shown to employee_directory_manage only (the server refuses everyone else).
 */
export function FactsCard({ e, editing, onEdit, readOnly = false }: { e: Employee; editing: boolean; readOnly?: boolean; onEdit: (open: boolean) => void }) {
  const facts = useQuery(factsQuery(e.id));
  return (
    <section className="card panel" aria-labelledby="facts">
      <h2 id="facts" className="panel__title" tabIndex={-1}>{t("facts.title")}</h2>
      <QueryState q={facts}>
        {(f) => (editing && !readOnly ? <FactsForm f={f} name={e.name} refetch={facts.refetch} onClose={() => onEdit(false)} /> : <FactsView f={f} name={e.name} onEdit={readOnly ? undefined : () => onEdit(true)} />)}
      </QueryState>
    </section>
  );
}

const notSet = <Muted>{t("facts.notSet")}</Muted>;

function FactsView({ f, name, onEdit }: { f: Facts; name: string; onEdit?: () => void }) {
  const m = f.employment ?? f.pending_employment;
  return (
    <>
      <dl className="kv">
        <dt>{t("facts.birthDate")}</dt><dd className="num">{f.birth_date ? <FieldValue employeeId={f.employee_id} allowed fieldCode="BIRTH_DATE" masked={maskedBirth()} field={t("facts.birthDate")} who={name} /> : notSet}</dd>
        <dt>{t("facts.workEmail")}</dt><dd>{f.work_email ?? notSet}</dd>
        <dt>{t("facts.idType")}</dt><dd>{f.id_type ? label(ID_TYPE, f.id_type) : notSet}</dd>
        {m && (
          <>
            <dt>{t("facts.employmentType")}</dt><dd>{m.employment_type ? label(EMPLOYMENT_TYPE, m.employment_type) : t("empCard.missing")}</dd>
            <dt>{t("facts.workerClass")}</dt><dd>{m.worker_classification ? label(WORKER_CLASS, m.worker_classification) : t("empCard.missing")}</dd>
            <dt>{t("facts.basePay")}</dt>
            <dd className="num">{m.base_pay_won != null && m.pay_unit ? t("facts.basePay.value", { unit: label(PAY_UNIT, m.pay_unit), amount: fmtNumber(m.base_pay_won) }) : notSet}</dd>
          </>
        )}
      </dl>
      {!m && <p className="muted">{t("facts.noProfile")}</p>}
      {m && m.probation_state !== "NONE" && <Probation f={f} name={name} readOnly={!onEdit} />}
      {onEdit && <div className="row">
        <Button onClick={onEdit}>{t("facts.edit")}</Button>
      </div>}
    </>
  );
}

/** The probation clock and, while it runs, the probation-end record (asserting the end date it shows). */
function Probation({ f, name, readOnly }: { f: Facts; name: string; readOnly: boolean }) {
  const m = (f.employment ?? f.pending_employment)!;
  const end = m.probation_end_date;
  const state = labeled(PROBATION_STATE, m.probation_state);
  const confirm = useCommand({
    run: () => confirmProbation(f.employee_id, end!),
    invalidates: ["/api/v1/employees"],
    announce: () => t("facts.probation.confirmed.receipt", { name }),
  });
  const line =
    m.probation_state === "CONFIRMED" && m.probation_confirmed_at
      ? t("facts.probation.confirmed", { date: fmtDateTime(m.probation_confirmed_at) })
      : end && m.probation_state === "OVERDUE"
        ? t("facts.probation.overdue", { date: fmtDate(end) })
        : end
          ? t("facts.probation.running", { date: fmtDate(end), days: m.probation_days_left ?? 0 })
          : null;
  const open = !readOnly && m.probation_state !== "CONFIRMED" && end;
  return (
    <div className="form">
      <div className="row">
        <span>{t("facts.probation")}</span>
        <Chip tone={state.tone}>{state.label}</Chip>
        {line && <Muted>{line}</Muted>}
      </div>
      {open && (
        <>
          <p id="probation-consequence" className="muted">{t("facts.probation.confirm.consequence", { name, date: fmtDate(end) })}</p>
          <div className="row">
            <Button variant="primary" disabled={confirm.isPending} aria-describedby="probation-consequence" onClick={() => confirm.mutate(undefined)}>
              {t("facts.probation.confirm")}
            </Button>
          </div>
          <CommandError error={confirm.error} />
        </>
      )}
    </div>
  );
}
