import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { isMessageId, t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { Button, Form } from "../../../ui/button/button";
import { BlockedPanel } from "../../../ui/blocker/blocked-panel";
import { Receipt } from "../../../ui/receipt/receipt";
import { Sheet } from "../../../ui/sheet/sheet";
import { CommandError } from "../../../lib/react/command-error";
import { LIFECYCLE_EVENT, actor, label } from "../../../lib/labels";
import { problemOf } from "../api";
import type { Effect } from "../domain/exits";
import type { ExitCommand } from "./use-exit-command";
import { ownRefusal } from "../../../reference/crud/present";
import s from "./exit.module.css";

/** A step form shown in a side sheet over the person's record instead of inline on the case page. */
export type SheetSpec = { kicker?: ReactNode; title: string; subtitle?: ReactNode; onClose: () => void };

/**
 * Every exit step form, inline at the case's current step or in a side sheet. The foot holds the consequence
 * sentence built from what will be sent, the statements the server requires (inline; in a sheet they end the
 * body, right above the foot), what stands in the way (a refusal, a lost response, a step someone else took),
 * then the decision row: `aside` on the left (back, or the case's reject and cancel), the primary on the
 * right with the count of fields still missing. The primary is never disabled for a missing field: pressing
 * it shows what is missing and moves focus there. In a sheet the foot stays in view while the body scrolls,
 * so submit buttons there name the form (`form={formId}`).
 *
 * `stale` is a step the case moved past while the form was open (someone else took it): the form stays,
 * read-only, with who did it, and `draft` (the typed memo) stays readable and copyable under the notice.
 */
export function StepFrame(p: {
  formId: string;
  onSubmit: () => void;
  sheet?: SheetSpec;
  run: ExitCommand;
  /** Another command of the same form in flight (the settlement's draft save). */
  busy?: boolean;
  stale?: Effect | null;
  /** What follows a stale form (the current step). */
  follow?: ReactNode;
  draft?: string;
  /** For a refusal that names the employee's scheduled records. */
  employeeId: string;
  consequence: ReactNode;
  note?: ReactNode;
  signoffs?: ReactNode;
  /** Fields still missing after a commit attempt (0 hides the line). */
  missing: number;
  aside?: ReactNode;
  primary: ReactNode;
  children: ReactNode;
}) {
  const { run, sheet } = p;
  const { phase } = run;
  const lost = phase.kind === "lost";
  const elsewhere = phase.kind === "elsewhere" ? phase.effect : (p.stale ?? null);
  const onClose = sheet?.onClose;
  const back = onClose && <Button onClick={onClose} disabled={run.pending}>{t("common.back")}</Button>;
  const consequence = (
    <>
      <p className={s.consequence}>{p.consequence}</p>
      {p.note != null && <p className={s.note}>{p.note}</p>}
    </>
  );
  const notice = (
    <>
      <Refusal error={run.error} employeeId={p.employeeId} />
      {(lost || run.checking) && (
        <div className={s.checking}>
          <Receipt state="checking" message={t("exit.check.title")} />
          <CommandError error={run.lookupError} />
        </div>
      )}
      {elsewhere && <Elsewhere effect={elsewhere} draft={p.draft} />}
      {phase.kind === "notRecorded" && <p className={s.note} role="status">{t("exit.check.notRecorded")}</p>}
    </>
  );
  const actions = lost ? (
    <>
      <span className={s.grow} />
      {back}
      <Button variant="primary" disabled={run.checking} onClick={run.checkNow}>{t("exit.check")}</Button>
    </>
  ) : elsewhere ? (
    <>
      <span className={s.grow} />
      {p.follow ?? back}
    </>
  ) : (
    <>
      {p.aside}
      <span className={s.grow} />
      {p.missing > 0 && <span className={s.missing} role="status">{t("exit.missing", { count: p.missing })}</span>}
      {p.primary}
    </>
  );
  const form = (body: ReactNode) => (
    <Form id={p.formId} className="form" noValidate onSubmit={p.onSubmit}>{body}</Form>
  );
  if (sheet)
    return (
      <Sheet
        open
        kicker={sheet.kicker}
        title={sheet.title}
        subtitle={sheet.subtitle}
        onClose={sheet.onClose}
        pending={run.pending || run.checking || p.busy}
        locked={run.locked || Boolean(elsewhere)}
        consequence={consequence}
        notice={notice}
        actions={actions}
      >
        {form(<>{p.children}{p.signoffs}</>)}
      </Sheet>
    );
  return form(
    <>
      {p.children}
      <div className={s.foot}>
        {consequence}
        {p.signoffs}
        {notice}
        <div className={s.decision}>{actions}</div>
      </div>
    </>,
  );
}

/** Someone else took the step: who and when, and what this user had typed, kept readable and copyable. */
function Elsewhere({ effect, draft }: { effect: Effect; draft?: string }) {
  return (
    <>
      <p className="notice" role="status">
        {effect.at ? t("live.notice.done_elsewhere", { actor: actor(effect.name), time: fmtDateTime(effect.at) }) : `${t("exit.unavailable")} · ${t("exit.unavailable.reason")}`}
      </p>
      {draft && (
        <div className={s.checking}>
          <span className={s.groupTitle}>{t("exit.draft")}</span>
          <p className={s.quote}>{draft}</p>
        </div>
      )}
    </>
  );
}

/**
 * A refusal the user can act on here. lifecycle_schedule_conflict names each scheduled record the exit would
 * strand, each with a way to withdraw it on the person's record (Back returns here, the draft kept). Anything
 * else shows the server's message and the operation id.
 */
function Refusal({ error, employeeId }: { error: unknown; employeeId: string }) {
  const p = problemOf(error);
  // CRUD: the report's own refusals (an exit date before the hire date, an open case) in words; the exit-reason refusals from the exit catalog first.
  if (!p || p.code !== "lifecycle_schedule_conflict") return <CommandError error={error} own={(code) => (isMessageId(`exit.error.${code}`) ? t(`exit.error.${code}` as never) : ownRefusal(code))} />;
  return (
    <BlockedPanel
      kind="generic"
      title={t("exit.blocker.schedule.title")}
      code={p.code}
      unblockers={[{ name: t("exit.blocker.you") }]}
      actions={<Link to="/people/$id" params={{ id: employeeId }} search={{}} className="btn">{t("exit.hr.blocking.open")}</Link>}
    >
      <ul className={s.lines}>
        {p.refusals.map((r) => (
          <li key={r.lifecycle_event_id}>
            {t("exit.hr.blocking.line", { date: fmtDate(r.effective_date), action: label(LIFECYCLE_EVENT, r.event_type) })} · {r.message}{" "}
            <CancelLink employeeId={employeeId} eventId={r.lifecycle_event_id} />
          </li>
        ))}
      </ul>
    </BlockedPanel>
  );
}

/** Withdraw one scheduled record on the person's page (its own sheet there); Back comes back to this form. */
export function CancelLink({ employeeId, eventId }: { employeeId: string; eventId: string }) {
  return <Link to="/people/$id" params={{ id: employeeId }} search={{ act: `cancel:${eventId}` }}>{t("exit.hr.blocking.cancel")}</Link>;
}
