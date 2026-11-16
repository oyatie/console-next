import { retirementDate } from "../domain/employment";
import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { commitLabel, verbLabel } from "../../../ui/composer/actions";
import { exitUndoVerb } from "../domain/exits";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { onRecordChange } from "../../../lib/live/live";
import { caseQuery, closeExit } from "../api";
import { StepFrame } from "./exit-foot";
import { focusFirstInvalid, useExitCommand } from "./use-exit-command";
import s from "./exit.module.css";

type Case = components["schemas"]["EmployeeExitCase"];
const REASON_MAX = 1000;

/**
 * Reject (any open state) or cancel (before HR confirmation), always in a sheet with its reason, never inline
 * beside a forward decision. Rejection after the exit applied records a compensating event; rejection of a
 * scheduled exit withdraws it.
 */
export function CloseForm({ c: opened, reject, onClose, onDone }: { c: Case; reject: boolean; onClose: () => void; onDone: (message: string, reference?: string) => void }) {
  const { data, refetch } = useQuery({ ...caseQuery(opened.id), initialData: opened });
  const c = data ?? opened;
  // Sheets hold list refreshes; this decision must still follow its case's SSE changes.
  useEffect(() => onRecordChange(({ type, id }) => {
    if (type === "exit_case" && id === opened.id) void refetch();
  }), [opened.id, refetch]);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const formId = useId();
  const name = c.employee_name;
  const run = useExitCommand({
    caseId: c.id,
    check: reject ? "reject_exit" : "cancel_exit",
    run: () => closeExit(c.id, reject, reason.trim()),
    onSuccess: () => onDone(t(reject ? "exit.rejected" : "exit.cancelled", { name }), c.id),
  });
  const exited = reject && (c.exit_event_state ? c.exit_event_state === "APPLIED" : Boolean(c.hr_confirmed_at));
  const scheduled = reject && c.exit_event_state === "SCHEDULED";
  const missing = reason.trim() ? 0 : 1;
  const mode = exitUndoVerb(c, reject);
  const action = commitLabel({ kind: "exit", mode });
  const unavailable = !reject && c.status !== "REPORTED";
  return (
    <StepFrame
      formId={formId}
      onSubmit={() => {
        setTried(true);
        if (missing === 0) run.submit(undefined);
        else focusFirstInvalid(formId);
      }}
      sheet={{ title: action, subtitle: name, onClose }}
      run={run}
      stale={unavailable ? { name: null } : null}
      employeeId={c.employee_id}
      draft={reason.trim()}
      consequence={unavailable ? null : t(exited ? "exit.close.consequence.reverse" : scheduled ? "exit.close.consequence.scheduled" : "exit.close.consequence", { name, date: fmtDate(retirementDate(c.effective_exit_date)) })}
      missing={tried ? missing : 0}
      action={{ kind: "exit", mode, count: 1 }}
      tone="danger"
    >
      {!unavailable && <fieldset className={s.group} disabled={run.locked}>
        <Field
          label={t("composer.reason", { verb: verbLabel(mode) })}
          required
          hint={t("exit.field.count", { count: reason.length, max: REASON_MAX })}
          error={tried && missing ? t("exit.error.text") : undefined}
        >
          {(p) => <TextArea {...p} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </fieldset>}
    </StepFrame>
  );
}
