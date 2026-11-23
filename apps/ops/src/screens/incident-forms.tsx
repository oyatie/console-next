// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { COPY } from "../copy";
import type { OpsIncidentDetail, OpsIncidentSeverity, OpsIncidentStatus, OpsPublicComponent } from "../lib/api";
import type { IncidentEventPayload } from "../lib/api-types";
import { hasOpsAction } from "../lib/auth";
import { useIncidentEventMutation, useIncidentPublicDraftMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { CmdReceipt } from "../ui/cmd-receipt";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import { SelectField } from "../ui/select-field";
import s from "./incidents-screen.module.css";

const EVENT_OPTIONS = [
  { value: "note_added", label: "Note added" },
  { value: "lead_assigned", label: "Lead assigned" },
  { value: "severity_changed", label: "Severity changed" },
  { value: "status_changed", label: "Status changed" },
  { value: "postmortem_linked", label: "Postmortem linked" },
  { value: "public_attached", label: "Public incident attached" },
  { value: "mitigation_added", label: "Mitigation added" },
  { value: "notice_sent", label: "Notice sent" },
  { value: "resolved", label: "Resolved" },
] as const;

const SEV_OPTIONS = [
  { value: "SEV1", label: "SEV1" },
  { value: "SEV2", label: "SEV2" },
  { value: "SEV3", label: "SEV3" },
  { value: "SEV4", label: "SEV4" },
] as const;

const STATUS_OPTIONS = [
  { value: "Investigating", label: "Investigating" },
  { value: "Identified", label: "Identified" },
  { value: "Monitoring", label: "Monitoring" },
  { value: "Resolved", label: "Resolved" },
] as const;

const PUBLIC_STAGE_OPTIONS = [
  { value: "Investigating", label: "Investigating" },
  { value: "Identified", label: "Identified" },
  { value: "Monitoring", label: "Monitoring" },
  { value: "Resolved", label: "Resolved" },
  { value: "Degraded performance", label: "Degraded performance" },
  { value: "Partial outage", label: "Partial outage" },
  { value: "Major outage", label: "Major outage" },
  { value: "Operational", label: "Operational" },
] as const;

export function IncidentForms({
  incident,
  onReload,
}: {
  incident: OpsIncidentDetail;
  onReload: () => void;
}) {
  const { me } = useOpsContext();
  const canWrite = hasOpsAction(me, "incident.write");
  const canPublish = hasOpsAction(me, "incident.publish");
  const isFinal = incident.status === "Resolved";

  const eventMut = useIncidentEventMutation(incident.id);
  const draftMut = useIncidentPublicDraftMutation(incident.id);

  const [evKind, setEvKind] = useState<IncidentEventPayload["event"]>("note_added");
  const [textA, setTextA] = useState("");
  const [textB, setTextB] = useState("");
  const [sevVal, setSevVal] = useState<OpsIncidentSeverity>(incident.sev);
  const [statusVal, setStatusVal] = useState<OpsIncidentStatus>(incident.status);

  const [stage, setStage] = useState<OpsIncidentStatus | OpsPublicComponent>("Investigating");
  const [componentsCsv, setComponentsCsv] = useState(() => incident.affected_components.join(", "));
  const [messageEn, setMessageEn] = useState("");
  const [messageKo, setMessageKo] = useState("");
  const [rev, setRev] = useState("1");

  const needsPostmortem = (incident.sev === "SEV1" || incident.sev === "SEV2") && !incident.postmortem_ref;
  const writeDisabled = !canWrite || isFinal;

  const submitEvent = (ev: React.FormEvent) => {
    ev.preventDefault();
    const seq = incident.head_seq;
    let payload: IncidentEventPayload;
    if (evKind === "note_added") payload = { expected_seq: seq, event: "note_added", fields: { note: textA.trim() } };
    else if (evKind === "lead_assigned") payload = { expected_seq: seq, event: "lead_assigned", fields: { lead: textA.trim() } };
    else if (evKind === "severity_changed") payload = { expected_seq: seq, event: "severity_changed", fields: { sev: sevVal, reason: textA.trim() || null } };
    else if (evKind === "status_changed") payload = { expected_seq: seq, event: "status_changed", fields: { status: statusVal, reason: textA.trim() || null } };
    else if (evKind === "postmortem_linked") payload = { expected_seq: seq, event: "postmortem_linked", fields: { postmortem_ref: textA.trim() } };
    else if (evKind === "public_attached") payload = { expected_seq: seq, event: "public_attached", fields: { public_incident_id: textA.trim() } };
    else if (evKind === "mitigation_added") payload = { expected_seq: seq, event: "mitigation_added", fields: { action_id: textA.trim(), summary: textB.trim() } };
    else if (evKind === "notice_sent") payload = { expected_seq: seq, event: "notice_sent", fields: { channel: textA.trim(), summary: textB.trim() || null } };
    else payload = { expected_seq: seq, event: "resolved", fields: { summary: textA.trim() || null } };

    eventMut.mutate(payload, {
      onSuccess: () => {
        setTextA("");
        setTextB("");
      },
    });
  };

  const submitDraft = (ev: React.FormEvent) => {
    ev.preventDefault();
    const comps = componentsCsv.split(",").map((c) => c.trim()).filter(Boolean);
    draftMut.mutate({
      expected_seq: incident.head_seq,
      stage,
      components: comps,
      message_en: messageEn.trim(),
      message_ko: messageKo.trim(),
      rev: Math.max(1, Number.parseInt(rev, 10) || 1),
    });
  };

  return (
    <div className={s.formsStack}>
      <section className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.incidents.sections.recordEvent}</h3>
        {!canWrite ? <DisabledReason reason={COPY.incidents.requiresWriteGrant} /> : null}
        {isFinal ? <DisabledReason reason={COPY.incidents.resolvedFinalReason} /> : null}
        {needsPostmortem ? <DisabledReason reason={COPY.incidents.postmortemNeededReason} /> : null}
        <form className={s.formPanel} onSubmit={submitEvent}>
          <SelectField label={COPY.incidents.fields.eventType} value={evKind} options={EVENT_OPTIONS} onChange={(v) => setEvKind(v as IncidentEventPayload["event"])} />
          {evKind === "severity_changed" ? <SelectField label={COPY.incidents.fields.sev} value={sevVal} options={SEV_OPTIONS} onChange={(v) => setSevVal(v as OpsIncidentSeverity)} /> : null}
          {evKind === "status_changed" ? <SelectField label={COPY.incidents.fields.status} value={statusVal} options={STATUS_OPTIONS} onChange={(v) => setStatusVal(v as OpsIncidentStatus)} /> : null}
          <label className={s.fieldLabel}>
            <span>
              {evKind === "lead_assigned" ? COPY.incidents.fields.lead
                : evKind === "postmortem_linked" ? COPY.incidents.fields.postmortemRef
                  : evKind === "public_attached" ? COPY.incidents.fields.publicIncidentId
                    : evKind === "mitigation_added" ? COPY.incidents.fields.actionId
                      : evKind === "notice_sent" ? COPY.incidents.fields.channel
                        : evKind === "severity_changed" || evKind === "status_changed" ? COPY.incidents.fields.reason
                          : evKind === "resolved" ? COPY.incidents.fields.summary
                            : COPY.incidents.fields.note}
            </span>
            <input type="text" className="field-input--form" value={textA} onChange={(e) => setTextA(e.target.value)} />
          </label>
          {evKind === "mitigation_added" || evKind === "notice_sent" ? (
            <label className={s.fieldLabel}>
              <span>{COPY.incidents.fields.summary}</span>
              <input type="text" className="field-input--form" value={textB} onChange={(e) => setTextB(e.target.value)} />
            </label>
          ) : null}
          {eventMut.error ? <InlineError error={eventMut.error} onReloadConflict={onReload} /> : null}
          <div>
            <button type="submit" className="btn btn--sm btn--primary" disabled={writeDisabled || eventMut.isPending}>
              {COPY.incidents.sections.submitEvent}
            </button>
          </div>
        </form>
      </section>

      <section className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.incidents.sections.publicDraft}</h3>
        {!canPublish ? <DisabledReason reason={COPY.incidents.requiresPublishGrant} /> : null}
        <form className={s.formPanel} onSubmit={submitDraft}>
          <div className={s.formGrid}>
            <SelectField label={COPY.incidents.fields.stage} value={stage} options={PUBLIC_STAGE_OPTIONS} onChange={(v) => setStage(v as OpsIncidentStatus | OpsPublicComponent)} />
            <label className={s.fieldLabel}>
              <span>{COPY.incidents.fields.revision}</span>
              <input type="number" min={1} className="field-input--form" value={rev} onChange={(e) => setRev(e.target.value)} />
            </label>
          </div>
          <label className={s.fieldLabel}>
            <span>{COPY.incidents.fields.components}</span>
            <input type="text" className="field-input--form" value={componentsCsv} onChange={(e) => setComponentsCsv(e.target.value)} />
          </label>
          <label className={s.fieldLabel}>
            <span>{COPY.incidents.fields.messageEn}</span>
            <textarea className="field-textarea" value={messageEn} onChange={(e) => setMessageEn(e.target.value)} />
          </label>
          <label className={s.fieldLabel}>
            <span>{COPY.incidents.fields.messageKo}</span>
            <textarea className="field-textarea" value={messageKo} onChange={(e) => setMessageKo(e.target.value)} />
          </label>
          {draftMut.error ? <InlineError error={draftMut.error} onReloadConflict={onReload} /> : null}
          {draftMut.data ? <CmdReceipt action={draftMut.data.action} /> : null}
          <div>
            <button type="submit" className="btn btn--sm btn--primary" disabled={!canPublish || isFinal || draftMut.isPending}>
              {COPY.incidents.sections.submitDraft}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
