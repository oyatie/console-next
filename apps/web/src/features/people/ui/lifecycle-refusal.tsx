// SPDX-License-Identifier: LicenseRef-Proprietary
import { supportReferenceFromError } from "../../../lib/support-reference";
import { t } from "@console/i18n";
import { LIFECYCLE_EVENT, actor, label } from "../../../lib/labels";
import { focusSoon } from "../../../lib/react/announce";
import { CommandError } from "../../../lib/react/command-error";
import { failureText } from "../../../lib/refusal";
import { BlockedPanel } from "../../../ui/blocker/blocked-panel";
import { Button } from "../../../ui/button/button";
import { refusalOf } from "../api";
import { FIXED_TERM_GROUNDS } from "../domain/fixed-term";
import { fmtDay, peopleRefusal } from "../present";
import { TransferCrossEntity, type CrossEntity } from "./transfer-refusal";
import s from "./lifecycle.module.css";

/** The record a BW-11 refusal names: the last change (stale_record) or the reservation in the way (scheduled_conflict). */
type Named = { event_id?: string; lifecycle_event_id?: string; event_type: string; effective_date: string; recorded_by?: string | null };
/** Refusals with their own title whose server message says the rest (BW-11 corrections, BW-12/13 facts). */
const SPECIFIC = new Set(["effective_date_before_hire", "second_person_required", "lifecycle_void_not_latest", "lifecycle_event_voided", "lifecycle_void_not_applied", "lifecycle_void_exit_owned", "lifecycle_void_unsupported", "demotion_reason_required", "job_title_unknown", "period_locked"] as const);
type Specific = typeof SPECIFIC extends Set<infer T> ? T : never;

/**
 * A server refusal of a lifecycle command, as a panel that names the fix (the form above keeps what was
 * typed). A schedule conflict lists each reservation it would break, each with "cancel that one"; a
 * no-op points back at the target; a state refusal offers the return from leave when that is the way
 * out. Anything else is the generic command error with its operation id.
 */
export function LifecycleRefusal({ error, kind, onLeave, target, onCancelEvent, onClose, onFocusTarget, onReturn, onReread, onReplace, onGroupTransfer }: {
  error: unknown;
  kind: string;
  onLeave: boolean;
  /** The current unit (transfer) or position (promote), for the no-op line. */
  target: string;
  onCancelEvent: (eventId: string) => void;
  /** Closes the sheet; the history (at the record a line names) then takes focus. */
  onClose: () => void;
  onFocusTarget: () => void;
  /** Present when the employee can return from leave now. */
  onReturn?: () => void;
  /** Reads the record again (a change made since the sheet read it), keeping the input. */
  onReread?: () => void;
  /** Replaces the named reservation of the same kind and date (BW-11), once a reason is given. */
  onReplace?: (eventId: string, date: string) => void;
  /** Opens the group transfer sheet (a transfer refused for crossing legal entities). */
  onGroupTransfer?: () => void;
}) {
  const r = refusalOf(error);
  const onHistory = (eventId?: string) => {
    onClose();
    focusSoon(...(eventId ? [`ev-${eventId}`] : []), "history");
  };
  const you = [{ name: t("lifecycle.blocker.you") }] as const;
  if (r?.code === "lifecycle_schedule_conflict" && r.events.length > 0)
    return (
      <BlockedPanel domain="hr" supportRef={supportReferenceFromError(error)} kind="route" title={t("lifecycle.blocker.schedule.title")} code={r.code} unblockers={you} actions={<Button onClick={() => onHistory()}>{t("lifecycle.blocker.history")}</Button>}>
        <ul className={s.lines}>
          {r.events.map((x) => (
            <li key={x.lifecycle_event_id} className={s.line}>
              <span className="grow">
                {t("lifecycle.blocker.schedule.line", {
                  date: fmtDay(x.effective_date),
                  action: label(LIFECYCLE_EVENT, x.event_type),
                  message: x.message,
                })}
              </span>
              <Button variant="ghost" onClick={() => onHistory(x.lifecycle_event_id)}>{t("lifecycle.blocker.open")}</Button>
              <Button onClick={() => onCancelEvent(x.lifecycle_event_id)}>{t("lifecycle.blocker.cancel")}</Button>
            </li>
          ))}
        </ul>
      </BlockedPanel>
    );
  const named = r?.events[0] as unknown as Named | undefined;
  if (r?.code === "stale_record")
    return (
      <BlockedPanel domain="hr" supportRef={supportReferenceFromError(error)} title={t("lifecycle.blocker.stale.title")} code={r.code} unblockers={you} actions={onReread && <Button variant="primary" onClick={onReread}>{t("lifecycle.blocker.stale.reread")}</Button>}>
        {named?.event_type
          ? t("lifecycle.blocker.stale.line", { action: label(LIFECYCLE_EVENT, named.event_type), date: fmtDay(named.effective_date), actor: actor(named.recorded_by) })
          : t("lifecycle.blocker.stale.body")}
      </BlockedPanel>
    );
  if (r?.code === "scheduled_conflict" && named?.event_id)
    return (
      <BlockedPanel domain="hr" supportRef={supportReferenceFromError(error)}
        kind="route"
        title={t("lifecycle.blocker.replace.title")}
        code={r.code}
        unblockers={you}
        actions={
          <>
            <Button variant="ghost" onClick={() => onHistory(named.event_id)}>{t("lifecycle.blocker.open")}</Button>
            {onReplace && <Button onClick={() => onReplace(named.event_id!, named.effective_date)}>{t("lifecycle.blocker.replace.do")}</Button>}
          </>
        }
      >
        {t("lifecycle.blocker.replace.body", { date: fmtDay(named.effective_date), action: label(LIFECYCLE_EVENT, named.event_type), actor: actor(named.recorded_by) })}
      </BlockedPanel>
    );
  if (r?.code === "fixed_term_limit" || r?.code === "fixed_term_basis_unconfirmed")
    return (
      <BlockedPanel domain="hr" supportRef={supportReferenceFromError(error)} title={t("lifecycle.blocker.fixedTerm.title")} code={r.code} unblockers={you} actions={<Button onClick={onFocusTarget}>{t("lifecycle.blocker.fixedTerm.fix")}</Button>}>
        <p className={s.blockerText}>{t(r.code === "fixed_term_basis_unconfirmed" ? "lifecycle.fixedTerm.basisUnconfirmed" : "lifecycle.blocker.fixedTerm.body")}</p>
        <ul className={s.grounds}>
          {FIXED_TERM_GROUNDS.map((g) => <li key={g}>{t(`lifecycle.fixedTerm.ground.${g}`)}</li>)}
        </ul>
        <p className={s.blockerText}>{t("lifecycle.blocker.fixedTerm.exception")}</p>
        {r.code === "fixed_term_limit" ? t("lifecycle.fixedTerm.limitExceeded") : failureText(error, peopleRefusal)}
      </BlockedPanel>
    );
  if (r && (SPECIFIC as Set<string>).has(r.code))
    return (
      <BlockedPanel domain="hr" supportRef={supportReferenceFromError(error)} title={t(`lifecycle.blocker.${r.code as Specific}`)} code={r.code} unblockers={you} actions={<Button onClick={() => onHistory()}>{t("lifecycle.blocker.history")}</Button>}>
        {r.message}
      </BlockedPanel>
    );
  if (r?.code === "lifecycle_scheduled_state")
    return (
      <BlockedPanel domain="hr" supportRef={supportReferenceFromError(error)} kind="route" title={t("lifecycle.blocker.state.title")} code={r.code} unblockers={you} actions={<Button onClick={() => onHistory()}>{t("lifecycle.blocker.history")}</Button>}>
        {r.message}
      </BlockedPanel>
    );
  if (r?.code === "transfer_cross_entity") return <TransferCrossEntity supportRef={supportReferenceFromError(error)} target={r.events[0] as unknown as CrossEntity | undefined} onFocusTarget={onFocusTarget} onGroupTransfer={onGroupTransfer} />;
  if (r?.code === "lifecycle_noop" && (kind === "TRANSFER" || kind === "PROMOTE"))
    return (
      <BlockedPanel domain="hr" supportRef={supportReferenceFromError(error)} title={t("lifecycle.blocker.noop.title")} code={r.code} unblockers={you} actions={<Button onClick={onFocusTarget}>{t(`lifecycle.blocker.noop.fix.${kind}`)}</Button>}>
        {t(`lifecycle.blocker.noop.${kind}`, { target })}
      </BlockedPanel>
    );
  if (r?.code === "invalid_transition")
    return (
      <BlockedPanel domain="hr" supportRef={supportReferenceFromError(error)}
        title={t("lifecycle.blocker.transition.title")}
        code={r.code}
        unblockers={you}
        actions={onLeave && onReturn ? <Button onClick={onReturn}>{t("people.lifecycle.action.RETURN_FROM_LEAVE")}</Button> : <Button onClick={() => onHistory()}>{t("lifecycle.blocker.history")}</Button>}
      >
        {r.message}
      </BlockedPanel>
    );
  return <CommandError error={error} own={peopleRefusal} />;
}
