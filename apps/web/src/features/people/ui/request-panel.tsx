import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { X } from "lucide-react";
import { mySub } from "../api";
import { decideRequest, type ChangeRequest } from "../api";
import { kindText, requestedChanges, statusOf, subjectText, valueText } from "../present";
import s from "./requests.module.css";

type Employee = components["schemas"]["Employee"];
type Decision = "APPLY" | "DECLINE" | "WITHDRAW";
const REASON_MAX = 100;
const NOTE_MAX = 1000;

/**
 * One request beside the list: what it asks (each field's requested value), why, who filed it and when, and how it
 * closed. HR applies or declines an open request filed by someone else; its requester alone may withdraw it. The
 * decision takes a reason; applying a correction writes it to the record in the same step.
 */
export function RequestPanel({ r, subject, hr, onClose, onDecided }: { r: ChangeRequest; subject?: Employee; hr: boolean; onClose: () => void; onDecided: (out: ChangeRequest) => void }) {
  const mine = r.requested_by === mySub();
  const open = r.status === "OPEN";
  const choices: Decision[] = !open ? [] : mine ? ["WITHDRAW"] : hr ? ["APPLY", "DECLINE"] : [];
  const status = statusOf(r.status);
  const changes = requestedChanges(r);
  return (
    <aside className="card panel" aria-label={t("requests.panel")}>
      <div className="panel__head">
        <h2 className="panel__title">{kindText(r.kind)}</h2>
        <Chip tone={status.tone}>{status.label}</Chip>
        <Button variant="ghost" onClick={onClose} aria-label={t("requests.panel.close")}><X size={16} aria-hidden /></Button>
      </div>
      <dl className="kv">
        <dt>{t("requests.col.subject")}</dt>
        <dd>{subject ? <Link to="/people/$id" params={{ id: subject.id }} search={{}}>{subjectText(r, subject)}</Link> : subjectText(r, subject)}</dd>
        <dt>{t("requests.col.at")}</dt>
        <dd className="num">{fmtDateTime(r.created_at)}{mine ? ` · ${t("requests.mine")}` : ""}</dd>
        <dt>{t("requests.col.reason")}</dt>
        <dd>{r.reason_code}</dd>
        {r.note && (
          <>
            <dt>{t("requests.note")}</dt>
            <dd>{r.note}</dd>
          </>
        )}
        {r.decided_at && (
          <>
            <dt>{t("requests.decided")}</dt>
            <dd>
              <span className="num">{fmtDateTime(r.decided_at)}</span> · {r.decision_reason_code ?? "—"}
              {r.decision_note ? ` · ${r.decision_note}` : ""}
            </dd>
          </>
        )}
      </dl>
      {changes.length > 0 && (
        <section aria-labelledby="rq-changes">
          <h3 id="rq-changes" className="panel__title">{t("requests.changes")}</h3>
          <ul className={s.changes}>
            {changes.map((c) => <li key={c.field}>{t("requests.change", { field: t(`profile.field.${c.field}`), value: valueText(c.field, c.value) })}</li>)}
          </ul>
        </section>
      )}
      {r.review_required && <p className="muted">{t("requests.review")}</p>}
      {choices.length > 0 ? <Decide key={r.id} r={r} choices={choices} onDecided={onDecided} /> : open && !hr && !mine ? null : open && <p className="muted">{t(mine ? "requests.waiting" : "requests.notYours")}</p>}
    </aside>
  );
}

/** The decision with its reason; the commit names what happens and is red for a decline or a withdrawal. */
function Decide({ r, choices, onDecided }: { r: ChangeRequest; choices: Decision[]; onDecided: (out: ChangeRequest) => void }) {
  const [decision, setDecision] = useState<Decision | null>(choices.length === 1 ? choices[0]! : null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const run = useCommand({
    run: () => decideRequest(r.id, { decision: decision!, reason: reason.trim(), note: note.trim() }),
    invalidates: ["/api/v1/change-requests", "/api/v1/employees"],
    // A decided request leaves the open list: the page says what was done.
    onSuccess: onDecided,
  });
  return (
    <Form
      className={s.decide}
      noValidate
      onSubmit={() => {
        setTried(true);
        if (decision && reason.trim()) run.mutate(undefined);
      }}
    >
      {choices.length > 1 && (
        <div className="row" role="group" aria-label={t("requests.decision")}>
          {choices.map((c) => (
            <Button key={c} aria-pressed={decision === c} onClick={() => (run.reset(), setDecision(c))}>{t(`requests.decide.${c}`)}</Button>
          ))}
        </div>
      )}
      {tried && !decision && <p className="field__error">{t("requests.decision.missing")}</p>}
      {decision && <p className="muted">{t(`requests.consequence.${decision}`)}</p>}
      <Field label={t("requests.decision.reason")} required hint={t("lifecycle.reason.count", { count: reason.length, max: REASON_MAX })} error={tried && !reason.trim() ? t("lifecycle.reason.missing") : undefined}>
        {(p) => <TextInput {...p} value={reason} maxLength={REASON_MAX} onChange={(e) => (run.reset(), setReason(e.target.value))} />}
      </Field>
      <Field label={t("requests.note")} required={false} hint={t("lifecycle.reason.count", { count: note.length, max: NOTE_MAX })}>
        {(p) => <TextArea {...p} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <CommandError error={run.error} />
      <div className="row">
        <span className="grow" />
        <Button type="submit" variant={decision === "APPLY" ? "primary" : "danger"} aria-disabled={run.isPending || undefined}>
          {t(`requests.commit.${decision ?? "none"}`)}
        </Button>
      </div>
    </Form>
  );
}
