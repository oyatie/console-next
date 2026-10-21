import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { reasonLabel } from "../../../lib/reason-codes";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LOCK_READS, approveUnlock, rejectUnlock, type PeriodLock, type UnlockRequest } from "../api";
import { requestState, type RequestState } from "../../../reference/periods/domain/request";
import { domainText, mine, periodText } from "../present";

const NOTE_MAX = 1000;
type Decided = "approved" | "rejected";

const who = (r: UnlockRequest) => r.requestedByName ?? t("periodLocks.closed.removed");
const subject = (l: PeriodLock) => ({ domain: domainText(l.domain), period: periodText(l) });

/** The request's state as a chip (waiting, refused, expired); nothing for a state no lock row shows. */
export function RequestChip({ state }: { state: RequestState }) {
  if (state === "PENDING") return <Chip tone="info">{t("periodLocks.request.chip.PENDING")}</Chip>;
  if (state === "REJECTED") return <Chip tone="danger">{t("periodLocks.request.chip.REJECTED")}</Chip>;
  if (state === "EXPIRED") return <Chip>{t("periodLocks.request.chip.EXPIRED")}</Chip>;
  return null;
}

/** The decision line: whose turn it is, who refused it and why, or that it ran out with nothing changed. */
function decisionText(r: UnlockRequest, state: RequestState) {
  if (state === "REJECTED") return t("periodLocks.request.decision.REJECTED", { name: r.decidedByName ?? t("periodLocks.closed.removed"), at: fmtDateTimeShort(r.decidedAt) });
  if (state === "EXPIRED") return t("periodLocks.request.decision.EXPIRED", { at: fmtDateTimeShort(r.relockAt) });
  if (r.canDecide) return t("periodLocks.request.decision.mine");
  return t(mine(r.requestedBy) ? "periodLocks.request.decision.waiting" : "periodLocks.request.decision.others");
}

/** What was asked: who and when, the reason and its note, until when the period would open, and the decision. */
function Facts({ r, state }: { r: UnlockRequest; state: RequestState }) {
  return (
    <KeyValue
      label={t("periodLocks.request.facts")}
      items={[
        { key: "requested", label: t("periodLocks.request.requested"), value: t("periodLocks.request.requestedValue", { name: who(r), at: fmtDateTimeShort(r.requestedAt) }) },
        { key: "reason", label: t("periodLocks.request.reason"), value: [reasonLabel("period_unlock", r.reasonCode), r.reasonNote].filter(Boolean).join(" · ") },
        { key: "window", label: t("periodLocks.request.window"), value: t("periodLocks.request.windowValue", { at: fmtDateTimeShort(r.relockAt) }) },
        { key: "decision", label: t("periodLocks.request.decision"), value: <>{decisionText(r, state)} <RequestChip state={state} /></> },
        ...(state === "REJECTED" && r.decisionNote ? [{ key: "note", label: t("periodLocks.request.decisionNote"), value: r.decisionNote }] : []),
      ]}
    />
  );
}

/**
 * One unlock request (BW-15, the K4 two-person card): what was asked and whose turn it is. The eligible second person
 * decides it here: approve with their own passkey bound to this request, or refuse it, which asks for the reason
 * the requester will read. The requester and anyone else see the request, never a decision they cannot make; a request
 * past its window shows it ran out. `asOf`: when the list was read (a request past its window by then reads as expired).
 */
export function UnlockRequestDialog({ lock, asOf, onClose, onDone }: { lock: PeriodLock | null; asOf: number; onClose: () => void; onDone: (l: PeriodLock, decided: Decided) => void }) {
  const r = lock?.unlockRequest;
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [pressed, setPressed] = useState(false);
  const reset = () => {
    setRejecting(false);
    setNote("");
    setPressed(false);
  };
  const decide = useCommand({
    run: async (decided: Decided, key: string) => {
      await (decided === "approved" ? approveUnlock(lock!.id, r!.id, key) : rejectUnlock(lock!.id, r!.id, note.trim(), key));
    },
    invalidates: LOCK_READS,
    onSuccess: (_, decided) => {
      reset();
      onDone(lock!, decided);
    },
  });
  const close = () => {
    reset();
    decide.reset();
    onClose();
  };
  const state = r ? requestState(r, asOf) : "PENDING";
  const deciding = r?.canDecide && state === "PENDING";
  // A cancelled passkey prompt is the person's own choice: nothing to report, the button asks again.
  const cancelled = decide.error instanceof Error && decide.error.message === "passkey_cancelled";
  const notice = cancelled ? null : <CommandError error={decide.error} own={ownRefusal} />;
  const busy = decide.isPending || undefined;
  const actions = !deciding ? (
    <Button onClick={close}>{t("common.back")}</Button>
  ) : rejecting ? (
    <>
      <Button onClick={() => (setRejecting(false), decide.reset())} disabled={decide.isPending}>{t("common.back")}</Button>
      <Button variant="danger" aria-disabled={busy} onClick={() => (setPressed(true), note.trim() && !decide.isPending && decide.mutate("rejected"))}>{t("periodLocks.request.reject")}</Button>
    </>
  ) : (
    <>
      <Button onClick={close} disabled={decide.isPending}>{t("common.back")}</Button>
      <Button onClick={() => (setRejecting(true), decide.reset())} disabled={decide.isPending}>{t("periodLocks.request.rejectOpen")}</Button>
      <Button variant="primary" aria-disabled={busy} onClick={() => !decide.isPending && decide.mutate("approved")}>{t("periodLocks.request.approve")}</Button>
    </>
  );
  return (
    <Dialog open={lock !== null && r !== undefined} title={lock ? t("periodLocks.request.title", subject(lock)) : ""} onClose={close} dismissable={!note.trim() && !decide.isPending}>
      {lock && r && (
        <div className="form">
          <Facts r={r} state={state} />
          {deciding && rejecting && (
            <Field label={t("periodLocks.request.decisionNote")} required error={pressed && !note.trim() ? t("periodLocks.request.reject.missing") : undefined}>
              {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          )}
          <ActionBar
            notice={notice}
            consequence={deciding ? (rejecting ? t("periodLocks.request.reject.consequence") : t("periodLocks.request.approve.consequence", { ...subject(lock), at: fmtDateTimeShort(r.relockAt) })) : undefined}
            actions={actions}
          />
        </div>
      )}
    </Dialog>
  );
}

/** The decision's refusals in this screen's words (every code the approve and reject routes return). */
const OWN = new Set(["second_person_required", "second_person_ineligible", "period_unlock_request_changed", "period_unlock_request_expired", "period_unlock_reject_note_invalid", "not_found"]);
const ownRefusal = (code: string) => (OWN.has(code) ? t(`periodLocks.request.refused.${code}` as "periodLocks.request.refused.not_found") : undefined);
