import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { User } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { addDays } from "../../../ui/date/days";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Banner } from "../../../ui/banner/banner";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { reasonCodesQuery, reasonLabel, useExitClass } from "../../../lib/reason-codes";
import { useDraft } from "../../../lib/react/use-draft";
import { eventsQuery, reportExit } from "../api";
import { OpsExitNote } from "./account-link-card";
import { StepFrame } from "./exit-foot";
import { focusFirstInvalid, useExitCommand } from "./use-exit-command";
import s from "./exit.module.css";

type Employee = components["schemas"]["Employee"];
const route = getRouteApi("/app/people/$id");
const NOTE_MAX = 1000;

/**
 * Reporting an exit opens its case (spec E5-exit); nothing about the employee changes until HR confirms. The last
 * working day has no default (it decides the outcome): a contract worker's contract end is offered as a chip, else it
 * is typed. What must be settled first is named above it: a reservation dated after that day would apply to someone
 * who has left. The exit reason is recorded once the exit is in effect (backend-followups EMP-UI 14).
 */
export function ReportForm({ employee, onClose, onDone }: { employee: Employee; onClose: () => void; onDone: (message: string, reference?: string) => void }) {
  const today = todayKst();
  const reasons = useQuery(reasonCodesQuery("exit_reason"));
  const draft = useDraft({
    route: "/people/$id", record: employee.id, form: "exit.report",
    initial: { date: "", note: "", reason: null as string | null },
    text: (v) => `${t("exit.report")} · ${employee.name}\n${t("exit.field.date")}: ${v.date}\n${t("exit.field.reason")}: ${v.reason ? reasonLabel("exit_reason", v.reason, reasons.data?.items.find((r) => r.code === v.reason)) : ""}\n${t("exit.field.circumstances")}: ${v.note}`,
  });
  const { date, note, reason } = draft.value;
  const reasonsRead = !reasons.isPending;
  const exitClass = useExitClass(reason);
  const [tried, setTried] = useState(false);
  const formId = useId();
  const navigate = route.useNavigate();
  const run = useExitCommand({
    check: "resend",
    run: (_: void, key: string) => reportExit({ employee_id: employee.id, effective_exit_date: date, site_manager_note: note.trim(), exit_reason_code: reason ?? undefined }, key),
    onSuccess: (out) => { draft.discard(); onDone(t("exit.reported", { name: employee.name }), out.id); },
  });
  const problems = { date: !date, note: !note.trim() };
  const missing = Object.values(problems).filter(Boolean).length;
  const when = date ? fmtDate(date) : "";
  const later = (useQuery(eventsQuery(employee.id)).data?.items ?? []).filter((x) => x.state === "SCHEDULED" && (!date || x.effective_date > date));
  return (
    <StepFrame
      formId={formId}
      onSubmit={() => {
        setTried(true);
        if (missing === 0) run.submit(undefined);
        else focusFirstInvalid(formId);
      }}
      sheet={{
        kicker: <><User size={12} aria-hidden />{t("lifecycle.kicker", { name: employee.name, number: employee.employee_number ?? "—", where: [employee.org_unit, employee.position].filter(Boolean).join(" · ") })}</>,
        title: t("exit.report"),
        onClose,
      }}
      run={run}
      loading={reasons.isPending}
      employeeId={employee.id}
      consequence={date ? t("exit.report.consequence.dated", { name: employee.name, date: when }) : t("exit.report.consequence", { name: employee.name })}
      note={draft.problem || draft.restored ? <output>{t(draft.problem ? "draft.unavailable" : "draft.restored")}</output> : undefined}
      missing={tried ? missing : 0}
      aside={draft.restored && !draft.problem && <Button variant="ghost" onClick={draft.discard} disabled={run.pending}>{t("draft.discard")}</Button>}
      action={{ kind: "exitReport", mode: "apply", count: 1 }}
    >
      <OpsExitNote employeeId={employee.id} search={employee.employee_number || employee.name} />
      <fieldset className={s.group} disabled={run.locked}>
        <DateField
          label={t("exit.field.date")}
          required
          today={today}
          presets={employee.contract_end_date ? [{ label: t("exit.field.date.contractEnd"), date: employee.contract_end_date }] : []}
          value={date}
          onChange={(nextDate) => draft.set({ ...draft.value, date: nextDate })}
          showErrors={tried}
          // Decision #9: the field is the last working day; the statutory exit date and the insurance loss date are the day after.
          echo={date ? `${t("exit.field.date.statutory")} ${fmtDate(addDays(date, 1))} · ${t("exit.field.date.loss")} ${fmtDate(addDays(date, 1))}` : undefined}
          error={tried && problems.date ? t("exit.error.date") : undefined}
        />
        {/* What to settle first sits under the date it depends on: drawn above it, it pushed the field being typed in down. */}
        {later.length > 0 && (
          <Banner tone="warn" live="polite" title={t("exit.report.first", { n: later.length })}>
            <ul className={s.lines}>
              {later.map((x) => (
                <li key={x.id} className={s.firstRow}>
                  <span>{t("exit.report.firstItem", { date: fmtDate(x.effective_date), action: label(LIFECYCLE_EVENT, x.event_type) })}</span>
                  {/* The withdrawal opens over the record and its receipt comes back to this report. */}
                  <Button variant="ghost" onClick={() => void navigate({ search: { act: `cancel:${x.id}`, back: "exit.report" } })}>{t("exit.report.cancelFirst")}</Button>
                </li>
              ))}
            </ul>
            <span>{t("exit.report.firstHint")}</span>
          </Banner>
        )}
        {/* The one exit reason list (BW-07 exit_reason; the case's code is the register's reason). Optional: unknown now, it is
            recorded on the card after the exit. */}
        {/* Drawn once the list has landed, with the field under it: twenty chips arriving late pushed it down. */}
        {reasonsRead && <ReasonCodeField domain="exit_reason" look="chips" required={false} label={t("exit.field.reason")} value={reason} onChange={(nextReason) => draft.set({ ...draft.value, reason: nextReason })} hint={t("exit.field.reason.hint")} />}
        {exitClass?.involuntary && <Chip tone="warn">{t("exit.class.involuntary")}</Chip>}
        {reasonsRead && <Field
          label={t("exit.field.circumstances")}
          hint={t("exit.field.count", { count: note.length, max: NOTE_MAX })}
          required
          error={tried && problems.note ? t("exit.error.text") : undefined}
        >
          {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={note} onChange={(e) => draft.set({ ...draft.value, note: e.target.value })} />}
        </Field>}
      </fieldset>
    </StepFrame>
  );
}
