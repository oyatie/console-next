import { retirementDate } from "../domain/employment";
import { useId, useState, type ReactNode } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { todayKst } from "../../../lib/pure/today";
import { draftExitApproval } from "../api";
import type { Effect } from "../domain/exits";
import { SettlementFigures } from "./exit-facts";
import { StepFrame, type SheetSpec } from "./exit-foot";
import { EXIT_INVALIDATES, focusFirstInvalid, useExitCommand } from "./use-exit-command";
import s from "./exit.module.css";

type Case = components["schemas"]["EmployeeExitCase"];
type Input = components["schemas"]["ExitSettlementInput"];
type Fields = { start: string; end: string; days: string; total: string; ordinary: string };
/** Which input feeds each server source field (missing_source_fields names them). */
const SOURCE: Record<keyof Fields, keyof Input> = {
  start: "average_wage_period_start",
  end: "average_wage_period_end",
  days: "average_wage_calendar_days",
  total: "average_wage_total_won",
  ordinary: "monthly_ordinary_wage_won",
};
const KEYS = Object.keys(SOURCE) as (keyof Fields)[];

/**
 * Wage sources for the statutory severance calculation. Saving the draft has the server compute the figures
 * (no client arithmetic); submitting sends no input, so the server files exactly the package on screen.
 * Submission waits, with its reason beside it, until the figures shown match the form and the exit is in effect.
 */
export function SettlementForm({ c, aside, sheet, stale, follow, onSaved, onDone }: {
  c: Case;
  aside?: ReactNode;
  sheet?: SheetSpec;
  stale?: Effect | null;
  follow?: ReactNode;
  onSaved?: () => void;
  onDone: (message: string, reference?: string) => void;
}) {
  const p = c.settlement_package;
  const stored: Fields = {
    start: p?.average_wage_period_start ?? "",
    end: p?.average_wage_period_end ?? "",
    days: p?.average_wage_calendar_days?.toString() ?? "",
    total: p?.average_wage_total_won?.toString() ?? "",
    ordinary: p?.monthly_ordinary_wage_won?.toString() ?? "",
  };
  const [f, setF] = useState(stored);
  const [tried, setTried] = useState(false);
  const formId = useId();
  const name = c.employee_name;
  const set = (k: keyof Fields) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const input: Input = {
    average_wage_period_start: f.start,
    average_wage_period_end: f.end,
    average_wage_calendar_days: Number(f.days),
    average_wage_total_won: Number(f.total),
    monthly_ordinary_wage_won: Number(f.ordinary),
  };
  // A saved draft keeps the form open: the refreshed package brings its figures here for review.
  const save = useCommand({
    run: () => draftExitApproval(c.id, { submit: false, settlement_input: input }),
    invalidates: EXIT_INVALIDATES,
    onSuccess: onSaved,
    announce: () => t("exit.settlement.drafted", { name }),
  });
  const submit = useExitCommand({
    caseId: c.id,
    check: "submit",
    run: () => draftExitApproval(c.id, { submit: true }),
    onSuccess: () => onDone(t("exit.settlement.submitted", { name }), c.id),
  });
  const same = KEYS.every((k) => f[k] === stored[k]);
  const computed = p && p.severance_pay_won != null && p.missing_source_fields.length === 0;
  const why =
    !computed ? t("exit.settlement.why.notComputed")
    : !same ? t("exit.settlement.why.changed")
    : c.exit_event_state === "SCHEDULED" ? t("exit.settlement.why.scheduled", { date: fmtDate(retirementDate(c.effective_exit_date)) })
    : c.exit_event_state === "APPLY_FAILED" ? t("exit.settlement.why.failed")
    : null;
  const empty = KEYS.filter((k) => !f[k]);
  // The server's missing-source list marks a field only once a draft was saved with figures: on a fresh form
  // every field is empty and nothing has been tried, so nothing is shown as wrong yet.
  const saved = KEYS.some((k) => stored[k]);
  const error = (k: keyof Fields) =>
    tried && !f[k] ? t("exit.error.text") : saved && same && p?.missing_source_fields.includes(SOURCE[k]) ? t("exit.settlement.missing") : undefined;
  const locked = save.isPending || submit.locked || Boolean(stale);
  const date = (k: "start" | "end", label: string) => (
    <DateField label={label} required value={f[k]} onChange={set(k)} today={todayKst()} error={tried && !f[k] ? t("exit.error.text") : undefined} />
  );
  const amount = (k: "total" | "ordinary", label: string) => (
    <Field label={label} required unit={t("exit.settlement.unit.won")} error={error(k)}>
      {(ctl) => <TextInput {...ctl} inputMode="numeric" className="num" value={f[k] ? fmtNumber(Number(f[k])) : ""} onChange={(e) => set(k)(e.target.value.replace(/[^\d]/g, ""))} />}
    </Field>
  );
  return (
    <StepFrame
      formId={formId}
      onSubmit={() => submit.submit(undefined)}
      sheet={sheet}
      run={submit}
      busy={save.isPending}
      stale={stale}
      follow={follow}
      employeeId={c.employee_id}
      consequence={t("exit.settlement.consequence", { name })}
      missing={tried ? empty.length : 0}
      aside={aside}
      action={{ kind: "settlement", mode: "request", count: 1 }}
      tone="danger"
      blocked={why ? { reason: why } : undefined}
      draftTone={computed && same ? "secondary" : "primary"}
      draftAction={{ kind: "settlement", mode: "calculate", count: 1 }}
      onSaveDraft={() => {
        setTried(true);
        if (empty.length === 0) save.mutate(undefined);
        else focusFirstInvalid(formId);
      }}

    >
      <fieldset className={s.group} disabled={locked}>
        <legend className={s.groupTitle}>{t("exit.settlement.period")}</legend>
        <div className={s.pair}>
          {date("start", t("exit.settlement.periodStart"))}
          {date("end", t("exit.settlement.periodEnd"))}
        </div>
        <Field label={t("exit.settlement.calendarDays")} required unit={t("exit.settlement.unit.days")}  error={error("days")}>
          {(ctl) => <TextInput {...ctl} inputMode="numeric" className="num" value={f.days} onChange={(e) => set("days")(e.target.value.replace(/[^\d]/g, ""))} />}
        </Field>
        <div className={s.pair}>
          {amount("total", t("exit.settlement.totalWage"))}
          {amount("ordinary", t("exit.settlement.ordinaryWage"))}
        </div>
      </fieldset>
      {p && same && <SettlementFigures pkg={p} />}
      <CommandError error={save.error} />
    </StepFrame>
  );
}
