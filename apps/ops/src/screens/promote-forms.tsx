// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { COPY } from "../copy";
import { hasOpsAction } from "../lib/auth";
import { formatFeedbackDisposition, formatPromoteVerdict } from "../lib/format";
import { usePromoteFeedbackMutation, usePromoteRequestMutation, usePromoteSignoffMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { CmdReceipt } from "../ui/cmd-receipt";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import { SelectField } from "../ui/select-field";
import s from "./promote-screen.module.css";

function getVerdictOptions() {
  return [
    { value: "ready", label: formatPromoteVerdict("ready") },
    { value: "blocked", label: formatPromoteVerdict("blocked") },
  ] as const;
}

const FEEDBACK_SEV_OPTIONS = [
  { value: "P0", label: "P0" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
] as const;

function getDispositionOptions() {
  return [
    { value: "open", label: formatFeedbackDisposition("open") },
    { value: "triaged", label: formatFeedbackDisposition("triaged") },
    { value: "resolved", label: formatFeedbackDisposition("resolved") },
    { value: "wontfix", label: formatFeedbackDisposition("wontfix") },
  ] as const;
}

export function PromoteForms({
  digest,
  promoState,
  bake,
}: {
  digest: string;
  promoState: string | null;
  bake: "normal" | "long" | null;
}) {
  const { me } = useOpsContext();
  const canPromote = hasOpsAction(me, "change.request.promote");
  const canSignoff = hasOpsAction(me, "promotion.signoff");
  const canFeedback = hasOpsAction(me, "feedback.triage");

  const reqMut = usePromoteRequestMutation();
  const signMut = usePromoteSignoffMutation();
  const fbMut = usePromoteFeedbackMutation();

  const [verdict, setVerdict] = useState<"ready" | "blocked">("ready");
  const [signNote, setSignNote] = useState("");
  const [feedbackId, setFeedbackId] = useState("");
  const [fbSeverity, setFbSeverity] = useState<"P0" | "P1" | "P2">("P1");
  const [fbDisposition, setFbDisposition] = useState<"open" | "triaged" | "resolved" | "wontfix">("resolved");
  const [fbNote, setFbNote] = useState("");

  const promoteBlockedReason = !canPromote
    ? COPY.o0.reasons.actionDenied
    : !digest || !bake
      ? COPY.promote.unknownReason
      : promoState === "Blocked"
        ? COPY.promote.blockedReason
        : promoState === "Watching"
          ? COPY.promote.watchingReason
          : promoState !== "Ready"
            ? COPY.promote.unknownReason
            : null;

  return (
    <div className={s.formsStack}>
      <section className={s.band} aria-labelledby="promote-request">
        <div className={s.bandHead}><h2 id="promote-request" className={s.bandTitle}>{COPY.promote.requestBtn}</h2></div>
        <div className={s.formBody}>
          <div className={s.inlineRow}>
            {bake ? <span>{COPY.promote.bakeLabel} · {bake === "long" ? COPY.promote.bakeLong : COPY.promote.bakeNormal}</span> : null}
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={Boolean(promoteBlockedReason) || reqMut.isPending}
              onClick={() => bake && reqMut.mutate({ digest, bake })}
            >
              {COPY.promote.requestBtn}
            </button>
            {promoState === "Ready" && !promoteBlockedReason ? <span>{COPY.promote.readyNote}</span> : <DisabledReason reason={promoteBlockedReason} />}
          </div>
          {reqMut.error ? <InlineError error={reqMut.error} /> : null}
          {reqMut.data ? <CmdReceipt action={reqMut.data.action} /> : null}
        </div>
      </section>

      <div className={s.splitGrid}>
        <section className={s.splitCell} aria-labelledby="promote-signoff-form">
          <div className={s.bandHead}><h2 id="promote-signoff-form" className={s.bandTitle}>{COPY.promote.signoffBtn}</h2></div>
          <form
            className={s.formBody}
            onSubmit={(e) => {
              e.preventDefault();
              signMut.mutate(
                { digest, verdict, note: signNote.trim() },
                { onSuccess: () => setSignNote("") },
              );
            }}
          >
            <SelectField label={COPY.promote.verdictLabel} value={verdict} options={getVerdictOptions()} onChange={(v) => setVerdict(v as "ready" | "blocked")} />
            <label className={s.fieldLabel}>
              <span>{COPY.promote.noteLabel}</span>
              <input type="text" className="field-input--form" value={signNote} onChange={(e) => setSignNote(e.target.value)} />
            </label>
            {signMut.error ? <InlineError error={signMut.error} /> : null}
            <div className={s.inlineRow}>
              <button type="submit" className="btn btn--sm btn--primary" disabled={!canSignoff || !digest || signMut.isPending}>
                {COPY.promote.signoffBtn}
              </button>
              {!canSignoff ? <DisabledReason reason={COPY.o0.reasons.actionDenied} /> : null}
            </div>
          </form>
        </section>

        <section className={s.splitCell} aria-labelledby="promote-feedback-form">
          <div className={s.bandHead}><h2 id="promote-feedback-form" className={s.bandTitle}>{COPY.promote.triageBtn}</h2></div>
          <form
            className={s.formBody}
            onSubmit={(e) => {
              e.preventDefault();
              fbMut.mutate(
                { feedback_id: feedbackId.trim(), digest, severity: fbSeverity, disposition: fbDisposition, note: fbNote.trim() },
                {
                  onSuccess: () => {
                    setFeedbackId("");
                    setFbNote("");
                  },
                },
              );
            }}
          >
            <div className={s.formGrid}>
              <label className={s.fieldLabel}>
                <span>{COPY.promote.feedbackIdLabel}</span>
                <input type="text" className="field-input--form" value={feedbackId} onChange={(e) => setFeedbackId(e.target.value)} />
              </label>
              <SelectField label={COPY.promote.severityLabel} value={fbSeverity} options={FEEDBACK_SEV_OPTIONS} onChange={(v) => setFbSeverity(v as "P0" | "P1" | "P2")} />
            </div>
            <div className={s.formGrid}>
              <SelectField label={COPY.promote.dispositionLabel} value={fbDisposition} options={getDispositionOptions()} onChange={(v) => setFbDisposition(v as "open" | "triaged" | "resolved" | "wontfix")} />
              <label className={s.fieldLabel}>
                <span>{COPY.promote.noteLabel}</span>
                <input type="text" className="field-input--form" value={fbNote} onChange={(e) => setFbNote(e.target.value)} />
              </label>
            </div>
            {fbMut.error ? <InlineError error={fbMut.error} /> : null}
            <div className={s.inlineRow}>
              <button type="submit" className="btn btn--sm btn--primary" disabled={!canFeedback || !digest || fbMut.isPending}>
                {COPY.promote.triageBtn}
              </button>
              {!canFeedback ? <DisabledReason reason={COPY.o0.reasons.actionDenied} /> : null}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
