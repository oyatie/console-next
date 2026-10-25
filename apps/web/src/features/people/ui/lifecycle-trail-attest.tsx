// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { canonical } from "../domain/canonical";
import { t } from "@console/i18n";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { DateField } from "../../../ui/date/date-field";
import { isDate } from "../../../ui/date/days";
import { OverrideSheet } from "../../../ui/override-sheet/override-sheet";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { useNeedsNote } from "../../../lib/reason-codes";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { completeCaseItem, trailPayloadHash, LIFECYCLE_CASE_READS, type CaseItem, type CompleteItem } from "../api/lifecycle-trail";
import { lifecycleTrailError, trailItemLabel } from "../present";

export function AttestSheet({ caseId, item, onClose }: { caseId: string; item: CaseItem; onClose: () => void }) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const needsNote = useNeedsNote("exception", code);
  const command = useCommand({
    run: (body: CompleteItem) => completeCaseItem(caseId, item.id, body),
    invalidates: LIFECYCLE_CASE_READS,
    onSuccess: onClose,
  });
  const ready = isDate(date) && name.trim() && URL.canParse(url) && new URL(url).protocol === "https:" && code && (!needsNote || note.trim());
  const [hash, setHash] = useState("");
  const payload = canonical({ case_id: caseId, item_id: item.id, expected_version: item.version, attestation: { fact_date: date, document: { name: name.trim(), url: url.trim() }, reason_code: code, note: note.trim() } });
  useEffect(() => { let current = true; void trailPayloadHash(payload).then((value) => { if (current) setHash(value); }); return () => { current = false; }; }, [payload]);
  const low = item.completion_risk === "LOW";
  return <OverrideSheet open title={t("lifecycle.trail.attest")} rule={{ title: trailItemLabel(item.label_key, item.label), detail: t("lifecycle.trail.evidenceHint"), code: item.completion_rule_ref ?? undefined }}
    risk={low ? "low" : "mid"} route={low ? { kind: "record" } : { kind: "step-up", binding: { action: "EXCEPTION_DECIDE", hash: hash.slice(0, 12) } }}
    reason={<div className="form">
      <DateField label={t("lifecycle.trail.factDate")} required value={date} onChange={setDate} today={todayKst()} />
      <Field label={t("lifecycle.trail.documentName")} required>{(p) => <TextInput {...p} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={t("lifecycle.trail.documentUrl")} required>{(p) => <TextInput {...p} type="url" maxLength={2000} value={url} onChange={(e) => setUrl(e.target.value)} />}</Field>
      <ReasonCodeField domain="exception" label={t("lifecycle.trail.reason")} value={code} onChange={setCode} />
      <Field label={t("lifecycle.trail.note")} required={needsNote}>{(p) => <TextArea {...p} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <CommandError error={command.error} own={lifecycleTrailError} />
    </div>}
    reasonComplete={Boolean(ready)} commitLabel={t("lifecycle.trail.attest")} pending={command.isPending} onClose={onClose}
    onCommit={() => { if (ready && !command.isPending) command.mutate({ expected_version: item.version, waive: false, attestation: { fact_date: date, document: { name: name.trim(), url: url.trim() }, reason_code: code!, note: note.trim() } }); }} />;
}

