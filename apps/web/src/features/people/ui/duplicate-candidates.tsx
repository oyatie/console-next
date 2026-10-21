import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { EMPLOYEE_STATUS, labeled } from "../../../lib/labels";
import { useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { employeeQuery, type DuplicateCandidate as Candidate, type DuplicateOverride } from "../api";
import { Muted } from "../../../ui/muted/muted";

const NOTE_MAX = 1000;

/**
 * The person may already be on file (same name and the same phone or birth date): each candidate is named by number
 * and status so it can be opened, and an exited one is rehired from its own record. Registering anyway is a recorded
 * exception: the user says why (the server's exception codes), and every candidate is named in it.
 */
export function DuplicateCandidates({ name, candidates, pending, onOverride }: {
  name: string;
  candidates: readonly Candidate[];
  pending: boolean;
  onOverride: (o: DuplicateOverride) => void;
}) {
  const reads = useQueries({ queries: candidates.map((c) => employeeQuery(c.employee_id)) });
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const needsNote = useNeedsNote("exception", code);
  const missing = !code ? t("reason.field.missing") : needsNote && !note.trim() ? t("people.duplicate.noteMissing") : undefined;
  const submit = () => {
    setTried(true);
    if (!missing) onOverride({ candidate_ids: candidates.map((c) => c.employee_id), reason_code: code!, note: note.trim() || undefined });
  };
  return (
    <section className="card panel" aria-labelledby="duplicate-title">
      <h2 id="duplicate-title" className="panel__title row">
        <Chip tone="warn">{t("people.duplicate.chip")}</Chip>
        {t("people.duplicate.title", { name })}
      </h2>
      <p>{t("people.duplicate.body")}</p>
      <ul className="list-plain">
        {candidates.map((c, i) => {
          const d = reads[i]?.data?.employee;
          const status = labeled(EMPLOYEE_STATUS, c.status);
          return (
            <li key={c.employee_id} className="row">
              <Link to="/people/$id" params={{ id: c.employee_id }} search={{}}>
                {t("people.sameName.other", { name: d?.name ?? name, number: c.employee_number ?? "—" })}
              </Link>
              <Chip tone={status.tone}>{status.label}</Chip>
              <Muted>{t(`people.duplicate.basis.${c.basis}`)}</Muted>
              {c.remedy === "rehire" && <Muted>{t("people.duplicate.rehire")}</Muted>}
            </li>
          );
        })}
      </ul>
      <ReasonCodeField domain="exception" label={t("people.duplicate.reason")} value={code} onChange={setCode} error={tried && !code ? t("reason.field.missing") : undefined} />
      <Field label={t("people.duplicate.note")} required={needsNote} error={tried && code && missing ? missing : undefined}>
        {(p) => <TextArea {...p} rows={2} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <div className="row">
        <span className="grow" />
        <Button variant="primary" onClick={submit} aria-disabled={pending || undefined}>{t("people.duplicate.commit")}</Button>
      </div>
    </section>
  );
}
