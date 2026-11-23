// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { COPY } from "../copy";
import { readObservedValue, type OpsAlertGroupDetail } from "../lib/api";
import { hasOpsAction } from "../lib/auth";
import { formatUtcTimestamp } from "../lib/format";
import { useAlertAckMutation, useCreateSilenceMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { validateSilenceDraft } from "../lib/validation";
import { Badge } from "../ui/badge";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import s from "./alerts-screen.module.css";

const BANNED_ACK = new Set(["no data", "n/a", "—"]);

function futureUtcZ(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function AlertDetailActions({
  group,
  initialAction,
}: {
  group: OpsAlertGroupDetail;
  initialAction?: "ack";
}) {
  const { me } = useOpsContext();
  const canAck = hasOpsAction(me, "alert.ack");
  const canSilence = hasOpsAction(me, "alert.silence");
  const isWatchdog = group.alertname.trim().toLowerCase() === "watchdog";
  const sev = String(readObservedValue(group.severity) ?? "Ticket");
  const compVal = readObservedValue(group.component);
  const comp = typeof compVal === "string" && compVal.trim() ? compVal.trim() : undefined;

  const [ackOpen, setAckOpen] = useState(initialAction === "ack");
  const [ackNote, setAckNote] = useState("");
  const [ackValidation, setAckValidation] = useState<string | null>(null);
  const [ackReceipt, setAckReceipt] = useState<string | null>(null);

  const [silenceOpen, setSilenceOpen] = useState(false);
  const [ttlHours, setTtlHours] = useState<number>(sev === "Page" ? 4 : 72);
  const [endsAt, setEndsAt] = useState<string>(() => futureUtcZ(sev === "Page" ? 4 : 72));
  const [comment, setComment] = useState("");
  const [silenceValidation, setSilenceValidation] = useState<string | null>(null);
  const [silenceCreatedId, setSilenceCreatedId] = useState<string | null>(null);

  const ackMut = useAlertAckMutation(group.key);
  const silenceMut = useCreateSilenceMutation();

  const submitAck = (ev: React.FormEvent) => {
    ev.preventDefault();
    setAckValidation(null);
    const trimmed = ackNote.trim();
    if (trimmed && BANNED_ACK.has(trimmed.toLowerCase())) {
      setAckValidation(COPY.alertActions.ackPlaceholderError);
      return;
    }
    ackMut.mutate(
      { note: trimmed || null },
      {
        onSuccess: (res) => {
          setAckReceipt(`${res.record.operator} · ${formatUtcTimestamp(res.record.at)}`);
          setAckOpen(false);
        },
      },
    );
  };

  const applyPreset = (hours: number) => {
    setTtlHours(hours);
    setEndsAt(futureUtcZ(hours));
  };

  const submitSilence = (ev: React.FormEvent) => {
    ev.preventDefault();
    setSilenceValidation(null);
    const matchers = [{ name: "alertname", value: group.alertname, is_equal: true, is_regex: false }];
    if (comp) matchers.push({ name: "component", value: comp, is_equal: true, is_regex: false });
    const err = validateSilenceDraft({
      matchers,
      endsAt,
      comment,
      maxHours: sev === "Page" ? 4 : 72,
    });
    if (err) {
      setSilenceValidation(err);
      return;
    }
    silenceMut.mutate(
      { matchers, ends_at: endsAt.trim(), comment: comment.trim(), group_key: group.key },
      {
        onSuccess: (res) => {
          setSilenceCreatedId(res.silence_id);
          setSilenceOpen(false);
        },
      },
    );
  };

  return (
    <div className={s.actionBox}>
      <div className={s.actionBar}>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={!canAck}
          aria-expanded={ackOpen}
          onClick={() => {
            setAckOpen((p) => !p);
            setSilenceOpen(false);
          }}
        >
          {COPY.alertActions.ackSubmit}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!canSilence || isWatchdog}
          aria-expanded={silenceOpen}
          onClick={() => {
            setSilenceOpen((p) => !p);
            setAckOpen(false);
          }}
        >
          {COPY.alertActions.silenceSubmit}
        </button>
        {!canAck ? <DisabledReason reason={COPY.alertActions.requiresAckGrant} /> : null}
        {!canSilence ? <DisabledReason reason={COPY.alertActions.requiresSilenceGrant} /> : null}
        {canSilence && isWatchdog ? <DisabledReason reason={COPY.alertActions.silenceWatchdogReason} /> : null}
      </div>

      {ackReceipt ? (
        <div className={s.receiptLine}>
          <Badge tone="ok">{COPY.alertActions.ackSuccess}</Badge>
          <span>{ackReceipt}</span>
        </div>
      ) : null}
      {silenceCreatedId ? (
        <div className={s.receiptLine}>
          <Badge tone="info">{silenceCreatedId}</Badge>
        </div>
      ) : null}

      {ackOpen ? (
        <form className={s.inlineForm} onSubmit={submitAck}>
          <h4 className={s.formHeading}>{COPY.alertActions.ackTitle}</h4>
          <label className={s.fieldLabel}>
            <span>{COPY.alertActions.ackNoteLabel}</span>
            <input
              type="text"
              className="field-input--form"
              placeholder={COPY.alertActions.ackNotePlaceholder}
              value={ackNote}
              onChange={(e) => setAckNote(e.target.value)}
            />
          </label>
          {ackValidation ? <p className={s.validationText} role="alert">{ackValidation}</p> : null}
          {ackMut.error ? <InlineError error={ackMut.error} /> : null}
          <div className={s.actionBar}>
            <button type="submit" className="btn btn--sm btn--primary" disabled={ackMut.isPending}>
              {COPY.alertActions.ackSubmit}
            </button>
          </div>
        </form>
      ) : null}

      {silenceOpen ? (
        <form className={s.inlineForm} onSubmit={submitSilence}>
          <h4 className={s.formHeading}>{COPY.alertActions.silenceTitle}</h4>
          <div className={s.presetRow}>
            <button
              type="button"
              className="btn btn--sm"
              aria-pressed={ttlHours === 4}
              onClick={() => applyPreset(4)}
            >
              {COPY.alertActions.silenceTtl4h}
            </button>
            {sev !== "Page" ? (
              <button
                type="button"
                className="btn btn--sm"
                aria-pressed={ttlHours === 72}
                onClick={() => applyPreset(72)}
              >
                {COPY.alertActions.silenceTtl72h}
              </button>
            ) : null}
          </div>
          <label className={s.fieldLabel}>
            <span>{COPY.alertActions.silenceCustomEndsAt}</span>
            <input
              type="text"
              className="field-input--form"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </label>
          <label className={s.fieldLabel}>
            <span>{COPY.alertActions.silenceCommentLabel}</span>
            <textarea
              className="field-textarea"
              placeholder={COPY.alertActions.silenceCommentPlaceholder}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          {silenceValidation ? <p className={s.validationText} role="alert">{silenceValidation}</p> : null}
          {silenceMut.error ? <InlineError error={silenceMut.error} /> : null}
          <div className={s.actionBar}>
            <button type="submit" className="btn btn--sm btn--primary" disabled={silenceMut.isPending}>
              {COPY.alertActions.silenceSubmit}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
