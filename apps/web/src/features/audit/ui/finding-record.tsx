// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { Button } from "../../../ui/button/button";
import { Composer } from "../../../ui/composer/composer";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { ApiError, findingsPath, triageFinding, type Finding, type Triage } from "../api";
import { findingCode } from "../present";

const outcomes = ["REVIEWED", "DISMISSED", "ESCALATED"] as const;

export function FindingRecord({ row }: { row: Finding }) {
  const allowed = useServedCapability("served_integrity_triage");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<Triage["status"] | "">("");
  const [memo, setMemo] = useState("");
  const [tried, setTried] = useState(false);
  const change = useCommand({
    run: (body: Triage, key) => triageFinding(row.id, body, key), invalidates: [findingsPath], settle: true,
    announce: () => t("audit.findings.saved"), onSuccess: () => setEditing(false),
  });
  const needsMemo = status === "DISMISSED" || status === "ESCALATED";
  const tooLong = Array.from(memo.trim()).length > 2000;
  const conflict = change.error instanceof ApiError && change.error.status === 409;
  function open() {
    change.reset(); setStatus(""); setMemo(""); setTried(false); setEditing(true);
  }
  function submit() {
    setTried(true);
    if (!allowed || row.status !== "OPEN" || !status || change.isPending || conflict || tooLong || (needsMemo && !memo.trim())) return false;
    change.mutate({ status, memo: memo.trim() || undefined });
  }
  return <>
    <KeyValue density="dense" items={[
      { key: "entity", label: t("audit.findings.entity"), value: row.entity_type },
      { key: "reference", label: t("audit.findings.reference"), value: row.entity_id },
      { key: "date", label: t("audit.findings.detected"), value: fmtDateTime(row.detected_at) },
      ...(row.reviewed_at ? [{ key: "reviewed", label: t("audit.findings.reviewedAt"), value: fmtDateTime(row.reviewed_at) }] : []),
      ...(row.review_memo ? [{ key: "memo", label: t("audit.findings.memo"), value: row.review_memo }] : []),
    ]} />
    {Object.keys(row.evidence).length > 0 && <RecordPaneSection title={t("audit.findings.facts")}><KeyValue density="dense" items={
      Object.entries(row.evidence).map(([key, value]) => ({ key, label: key, value: typeof value === "string" ? value : JSON.stringify(value) }))
    } /></RecordPaneSection>}
    {allowed && row.status === "OPEN" && <RecordPaneSection title={t("audit.findings.triage")}>
      {editing ? <Composer layout="inline" headingLevel={4} title={t("audit.findings.triage")}
        action={{ kind: "findingReview", mode: "record" }} pending={change.isPending} onClose={() => setEditing(false)} onSubmit={submit}>
        <Field required label={t("audit.findings.outcome")}>{props => <SelectInput {...props} required value={status}
          onChange={e => setStatus(outcomes.find(outcome => outcome === e.target.value) ?? "")}>
          <option value="">{t("audit.findings.choose")}</option>
          {outcomes.map(outcome => <option key={outcome} value={outcome}>{findingCode(outcome)}</option>)}</SelectInput>}</Field>
        <Field required={needsMemo} label={t("audit.findings.memo")} error={tooLong || (tried && needsMemo && !memo.trim()) ? t("audit.findings.noteHint") : undefined}>{props => <TextInput {...props} value={memo}
          required={needsMemo} onChange={e => setMemo(e.target.value)} />}</Field>
      </Composer> : <Button onClick={open}>{t("audit.findings.triage")}</Button>}
    </RecordPaneSection>}
    {change.error && row.status === "OPEN" && <CommandError error={change.error} />}
    {conflict && row.status !== "OPEN" && <p role="status">{t("audit.findings.alreadyReviewed")}</p>}
    {change.isSuccess && <p role="status">{t("audit.findings.saved")}</p>}
  </>;
}
