import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Checks } from "../../../ui/choice/checks";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { useCan } from "../../../reference/authz/ui/use-can";
import { confirmExit, eventsQuery } from "../api";
import { blockingSchedules, EMPTY_NOTICE, noticeMissing, protectedLines, EXIT_ACKS, type NoticeDraft, type Effect } from "../domain/exits";
import { OpsExitNote } from "./account-link-card";
import { CaseFacts } from "./exit-facts";
import { CancelLink, StepFrame, type SheetSpec } from "./exit-foot";
import { focusFirstInvalid, useExitCommand } from "./use-exit-command";
import { useExitClass } from "../../../lib/reason-codes";
import { ExitGuardFields } from "./exit-notice";
import s from "./exit.module.css";

type Case = components["schemas"]["EmployeeExitCase"];
type Draft = { note: string; acks: Record<string, boolean>; reason: string | null; notice: NoticeDraft };
const MEMO_MAX = 1000;
const EMPTY: Draft = { note: "", acks: {}, reason: null, notice: EMPTY_NOTICE };
/** Keep unsaved case edits when the user leaves to withdraw a blocking reservation and returns. */
const drafts = new Map<string, Draft>();

/**
 * HR confirmation records the exit itself (applied now for a date of today or earlier, scheduled for a later
 * one) and carries the four statements the server requires, each ticked on its own. HQ confirmation is a
 * second person's confirmation of the case facts. The memo is kept in the audit log only: the case does not
 * return it, so the screen says so instead of implying the next person reads it.
 */
export function ConfirmForm({ c, hq, aside, sheet, stale, follow, onDone }: {
  c: Case;
  hq: boolean;
  aside?: ReactNode;
  sheet?: SheetSpec;
  stale?: Effect | null;
  follow?: ReactNode;
  onDone: (message: string, reference?: string) => void;
}) {
  const slot = `${c.id}:${hq ? "hq" : "hr"}`;
  const [draft, setDraftState] = useState(() => drafts.get(slot) ?? { ...EMPTY, reason: c.exit_reason_code ?? null });
  const setDraft = (next: Draft) => {
    drafts.set(slot, next);
    setDraftState(next);
  };
  const { note, acks, reason, notice } = draft;
  const selectedClass = useExitClass(reason);
  const involuntary = selectedClass?.involuntary ?? c.involuntary;
  const noticeRequired = selectedClass?.notice_required ?? c.notice_required;
  const periods = protectedLines(c);
  const protectedBlock = !hq && involuntary && periods.length > 0;
  const missingNotice = !hq && noticeRequired ? noticeMissing(notice, c.effective_exit_date) : [];
  const blockReason = protectedBlock ? t("exit.error.exit_protected_period") : !hq && !reason ? t("exit.error.exit_reason_required") : missingNotice.length ? t("exit.notice.required") : null;
  const [tried, setTried] = useState(false);
  const formId = useId();
  const name = c.employee_name;
  const date = fmtDate(c.effective_exit_date);
  // A date after today schedules the exit; today or earlier applies it now (undone only by rejecting the case).
  const scheduled = c.effective_exit_date > todayKst();
  const run = useExitCommand({
    caseId: c.id,
    check: hq ? "confirm_exit_hq" : "confirm_exit",
    run: () => confirmExit(c.id, { hq_confirmation: hq, exit_reason_code: hq ? undefined : reason ?? undefined, dismissal_notice: !hq && noticeRequired ? { ...notice, method: notice.method as "IN_PERSON_SIGNED" | "CERTIFIED_MAIL" | "ELECTRONIC" } : undefined, note: note.trim() || undefined, signoffs: hq ? undefined : (Object.fromEntries(EXIT_ACKS.map((k) => [k, Boolean(acks[k])])) as Record<(typeof EXIT_ACKS)[number], boolean>) }),
    onSuccess: (out) => {
      drafts.delete(slot);
      onDone(t(hq ? "exit.hqConfirmed" : out.exit_event_state === "SCHEDULED" ? "exit.hrConfirmed.scheduled" : "exit.hrConfirmed", { name, date }), c.id);
    },
  });
  const missing = hq ? 0 : EXIT_ACKS.filter((k) => !acks[k]).length + Number(!reason) + missingNotice.length;
  const consequence = t(hq ? "exit.hq.consequence" : scheduled ? "exit.hr.consequence.scheduled" : "exit.hr.consequence", { name, date });
  const locked = run.locked || Boolean(stale);
  return (
    <StepFrame
      formId={formId}
      onSubmit={() => {
        setTried(true);
        if (missing === 0 && !protectedBlock) run.submit(undefined);
        else focusFirstInvalid(formId);
      }}
      sheet={sheet}
      run={run}
      stale={stale}
      follow={follow}
      draft={note.trim()}
      employeeId={c.employee_id}
      consequence={consequence}
      signoffs={
        !hq && (
          <Checks
            label={t("exit.acks")}
            items={EXIT_ACKS.map((k) => ({ id: k, label: t(`exit.ack.${k}`) }))}
            value={EXIT_ACKS.filter((k) => acks[k])}
            onChange={(v) => setDraft({ ...draft, note, acks: Object.fromEntries(EXIT_ACKS.map((k) => [k, v.includes(k)])) })}
            error={tried && missing > 0 ? t("lifecycle.signoffs.missing") : undefined}
            isDisabled={locked}
          />
        )
      }
      missing={tried ? missing : 0}
      aside={aside}
      blocked={blockReason ? { reason: blockReason } : undefined}
      action={{ kind: hq ? "exitHq" : "exit", mode: !hq && scheduled ? "schedule" : "apply", count: 1 }}
      tone={!hq && !scheduled ? "danger" : "primary"}
    >
      {!hq && <OpsExitNote employeeId={c.employee_id} search={c.employee_number || c.employee_name} />}
      <fieldset className={s.group} disabled={locked}>
        <CaseFacts c={c} full={!hq} />
        {!hq && <Blocking c={c} />}
        {!hq && <ExitGuardFields c={c} reason={reason} onReason={(nextReason) => setDraft({ ...draft, reason: nextReason })} involuntary={involuntary} noticeRequired={noticeRequired} value={notice} onChange={(nextNotice) => setDraft({ ...draft, notice: nextNotice })} tried={tried} />}
        <Field label={t("exit.field.confirmMemo")} required={false} hint={t("exit.field.count", { count: note.length, max: MEMO_MAX })}>
          {(p) => <TextArea {...p} maxLength={MEMO_MAX} value={note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />}
        </Field>
      </fieldset>
    </StepFrame>
  );
}

/**
 * Records scheduled after the exit date: the server refuses the HR confirmation until they are withdrawn, so
 * they are listed before the statements are ticked, each with a way to withdraw it (the draft here is kept).
 * Read only by someone who can read the history.
 */
function Blocking({ c }: { c: Case }) {
  const can = useCan();
  const events = useQuery({ ...eventsQuery(c.employee_id), enabled: can("employee_directory_read", "all") });
  const blocking = blockingSchedules(events.data?.items ?? [], c.effective_exit_date);
  if (blocking.length === 0) return null;
  return (
    <div className={`${s.blocking} prose`} role="note">
      <span>{t("exit.hr.blocking", { count: blocking.length })}</span>
      <ul className={s.lines}>
        {blocking.map((x) => (
          <li key={x.id}>
            {t("exit.hr.blocking.line", { date: fmtDate(x.effective_date), action: label(LIFECYCLE_EVENT, x.event_type) })}{" "}
            {can("employee_directory_manage", "all") && <CancelLink employeeId={c.employee_id} eventId={x.id} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
