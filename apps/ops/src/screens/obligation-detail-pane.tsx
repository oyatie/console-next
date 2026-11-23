// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, X } from "lucide-react";
import { COPY } from "../copy";
import { fetchOpsObligationDetail, opsQueryKeys } from "../lib/api";
import { readObligationFields } from "../lib/api-types";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtCountLabel, fmtJoin, formatObligationEvent, formatObligationKind, formatObligationRole, formatObligationState, formatUtcTimestamp } from "../lib/format";
import { useObligationEventMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { Badge, type BadgeTone } from "../ui/badge";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import { KeyValue } from "../ui/key-value";
import { O0State } from "../ui/o0-state";
import { SelectField } from "../ui/select-field";
import s from "./obligations-screen.module.css";

function stateTone(state: string): BadgeTone {
  if (state === "done" || state === "waived") return "ok";
  if (state === "in-review") return "info";
  return "warn";
}

export function ObligationDetailPane({
  id,
  chainBroken,
  isMobileFull,
}: {
  id: string;
  chainBroken: boolean;
  isMobileFull?: boolean;
}) {
  const { me } = useOpsContext();
  const canWrite = hasOpsAction(me, "obligation.write");
  const mut = useObligationEventMutation(id);

  const [actionType, setActionType] = useState<"in_review" | "redated" | "done" | "waived">("in_review");
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [signer, setSigner] = useState("");
  const [signedOn, setSignedOn] = useState(() => new Date().toISOString().slice(0, 10));

  const query = useQuery({
    queryKey: opsQueryKeys.obligationDetail(id),
    queryFn: () => fetchOpsObligationDetail(id),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (query.isPending) {
    return <p className={s.emptyNote}>{COPY.loading.obligationDetailTitle}</p>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const { item, history } = query.data;
  if (!item) {
    return (
      <div className={s.detailStack}>
        {isMobileFull ? (
          <div className={s.mobileBack}>
            <Link to="/obligations" className="btn btn--sm">
              <ArrowLeft size={12} aria-hidden="true" />
              <span>{COPY.obligations.detail.back}</span>
            </Link>
          </div>
        ) : null}
        <p className={s.emptyNote}>{COPY.obligations.chainBrokenBanner}</p>
      </div>
    );
  }

  const isFinal = item.state === "done" || item.state === "waived";
  const writeDisabled = !canWrite || isFinal || chainBroken;
  const disabledMsg = !canWrite
    ? COPY.obligations.detail.requiresWriteGrant
    : chainBroken
      ? COPY.obligations.detail.chainBrokenReason
      : isFinal
        ? COPY.obligations.detail.finalizedReason
        : undefined;

  const submitTransition = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (actionType === "in_review") {
      mut.mutate({ event: "in_review", fields: { note: note.trim() || null } });
    } else if (actionType === "redated") {
      mut.mutate({ event: "redated", fields: { due: due.trim(), reason: reason.trim() } });
    } else if (actionType === "done") {
      mut.mutate({
        event: "done",
        fields: { evidence_ref: evidenceRef.trim(), signer: signer.trim(), signed_on: signedOn.trim() },
      });
    } else {
      mut.mutate({ event: "waived", fields: { reason: reason.trim(), signer: signer.trim() } });
    }
  };

  return (
    <div className={s.detailStack}>
      {isMobileFull ? (
        <div className={s.mobileBack}>
          <Link to="/obligations" className="btn btn--sm">
            <ArrowLeft size={12} aria-hidden="true" />
            <span>{COPY.obligations.detail.back}</span>
          </Link>
        </div>
      ) : null}

      <section className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.obligations.detail.summary}</h3>
        <KeyValue
          items={[
            { id: "id", label: COPY.obligations.cols.id, value: <code>{item.id}</code> },
            { id: "kind", label: COPY.obligations.cols.kind, value: formatObligationKind(item.kind) },
            { id: "role", label: COPY.obligations.cols.role, value: formatObligationRole(item.reviewer_role) },
            { id: "state", label: COPY.obligations.cols.state, value: <Badge tone={stateTone(item.state)}>{formatObligationState(item.state)}</Badge> },
            { id: "due", label: COPY.obligations.cols.due, value: item.due ?? COPY.observed.notInstrumented },
            { id: "deadline", label: COPY.obligations.cols.deadline, value: item.deadline },
            { id: "evidence", label: COPY.obligations.fields.evidenceRef, value: item.evidence_ref ?? COPY.observed.notInstrumented },
            { id: "signer", label: COPY.obligations.fields.signer, value: item.signer ?? COPY.now.unassigned },
            { id: "signedOn", label: COPY.obligations.detail.signedOn, value: item.signed_on ?? COPY.observed.notInstrumented },
          ]}
        />
      </section>

      <section className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.obligations.detail.actions}</h3>
        {disabledMsg ? <DisabledReason reason={disabledMsg} /> : null}
        <form className={s.formPanel} onSubmit={submitTransition}>
          <SelectField
            label={COPY.obligations.detail.actions}
            value={actionType}
            options={[
              { value: "in_review", label: COPY.obligations.detail.startReview },
              { value: "redated", label: COPY.obligations.detail.redate },
              { value: "done", label: COPY.obligations.detail.markDone },
              { value: "waived", label: COPY.obligations.detail.waive },
            ]}
            onChange={(v) => setActionType(v as "in_review" | "redated" | "done" | "waived")}
          />
          {actionType === "in_review" ? (
            <label className={s.fieldLabel}>
              <span>{COPY.obligations.fields.note}</span>
              <input type="text" className="field-input--form" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          ) : null}
          {actionType === "redated" ? (
            <>
              <label className={s.fieldLabel}>
                <span>{COPY.obligations.fields.due}</span>
                <input type="text" className="field-input--form" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
              <label className={s.fieldLabel}>
                <span>{COPY.obligations.fields.reason}</span>
                <input type="text" className="field-input--form" value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            </>
          ) : null}
          {actionType === "done" ? (
            <>
              <label className={s.fieldLabel}>
                <span>{COPY.obligations.fields.evidenceRef}</span>
                <input type="text" className="field-input--form" value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} />
              </label>
              <label className={s.fieldLabel}>
                <span>{COPY.obligations.fields.signer}</span>
                <input type="text" className="field-input--form" value={signer} onChange={(e) => setSigner(e.target.value)} />
              </label>
              <label className={s.fieldLabel}>
                <span>{COPY.obligations.fields.signedOn}</span>
                <input type="text" className="field-input--form" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} />
              </label>
            </>
          ) : null}
          {actionType === "waived" ? (
            <>
              <label className={s.fieldLabel}>
                <span>{COPY.obligations.fields.reason}</span>
                <input type="text" className="field-input--form" value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <label className={s.fieldLabel}>
                <span>{COPY.obligations.fields.signer}</span>
                <input type="text" className="field-input--form" value={signer} onChange={(e) => setSigner(e.target.value)} />
              </label>
            </>
          ) : null}
          {mut.error ? <InlineError error={mut.error} /> : null}
          <div>
            <button
              type="submit"
              className="btn btn--sm btn--primary"
              disabled={writeDisabled || mut.isPending || (actionType === "in_review" && item.state !== "open")}
            >
              {actionType === "in_review"
                ? COPY.obligations.detail.startReview
                : actionType === "redated"
                  ? COPY.obligations.detail.redate
                  : actionType === "done"
                    ? COPY.obligations.detail.markDone
                    : COPY.obligations.detail.waive}
            </button>
          </div>
        </form>
      </section>

      <section className={s.detailSection}>
        <h3 className={s.detailLabel}>{fmtCountLabel(COPY.obligations.detail.history, history.length)}</h3>
        {history.length > 0 ? (
          <ul className={s.historyList}>
            {history.map((rec) => {
              const fields = readObligationFields(rec.fields);
              const detailText =
                (typeof fields.reason === "string" && fields.reason) ||
                (typeof fields.note === "string" && fields.note) ||
                (typeof fields.evidence_ref === "string" && fields.evidence_ref) ||
                (typeof fields.title === "string" && fields.title) ||
                "";
              return (
                <li key={rec.seq} className={s.historyItem}>
                  <div className={s.historyHead}>
                    <Badge tone="outline">{fmtJoin("#", rec.seq, " ", formatObligationEvent(rec.event))}</Badge>
                    <span>{formatUtcTimestamp(rec.at)}</span>
                  </div>
                  <div className={s.historyMeta}>
                    <span>{fmtJoin(rec.operator.person, " (", rec.operator.method, ") · ", rec.support_ref)}</span>
                  </div>
                  {detailText ? <div className={s.historyBody}>{detailText}</div> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={s.emptyNote}>{COPY.obligations.detail.noHistory}</p>
        )}
      </section>
    </div>
  );
}

export function ObligationCloseButton() {
  return (
    <Link to="/obligations" className={`btn btn--sm ${s.desktopClose}`} aria-label={COPY.alerts.closeDetail}>
      <X size={12} aria-hidden="true" />
      <span>{COPY.alerts.closeDetail}</span>
    </Link>
  );
}
