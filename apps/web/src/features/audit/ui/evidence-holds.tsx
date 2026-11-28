// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useCommand } from "../../../lib/react/command";
import { changeEvidenceHold, type EvidenceHold, type EvidenceHoldRequest } from "../api";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { CommandError } from "../../../lib/react/command-error";
import { Composer } from "../../../ui/composer/composer";
import { Button } from "../../../ui/button/button";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { Field, TextInput } from "../../../ui/field/field";

export function EvidenceHolds({ id, holds, manage }: { id: string; holds: EvidenceHold[]; manage: boolean }) {
  const [edit, setEdit] = useState<{ hold?: EvidenceHold; approval: string; caseRef: string; basis: string; reason: string }>();
  const [tried, setTried] = useState(false);
  const validApproval = !!edit && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(edit.approval.trim());
  const change = useCommand({
    run: (body: EvidenceHoldRequest, key) => changeEvidenceHold(id, body, key),
    invalidates: ["/api/v1/evidence/objects"], settle: true,
    onSuccess: () => setEdit(undefined),
  });
  const choose = (hold?: EvidenceHold) => {
    change.reset();
    setTried(false);
    setEdit({ hold, approval: "", caseRef: "", basis: "", reason: "" });
  };
  function submit() {
    if (!edit || !manage || change.isPending) return;
    setTried(true);
    const reason = edit.reason.trim();
    if (!reason || (edit.hold ? !validApproval : !edit.caseRef.trim() || !edit.basis.trim())) return false;
    change.mutate(edit.hold
      ? { op: "release", hold_id: edit.hold.id, reason, four_eyes_request_ref: edit.approval.trim() }
      : { op: "apply", case_ref: edit.caseRef.trim(), basis: edit.basis.trim(), reason });
  }
  return <RecordPaneSection title={t("audit.vault.holds")}>
    {holds.length ? <ul>{holds.map(hold => <li key={hold.id}>
      <strong>{hold.case_ref}</strong> · {t(hold.status === "ACTIVE" ? "audit.vault.code.ACTIVE" : "audit.vault.released")} · {fmtDateTime(hold.applied_at)}
      <p>{hold.basis} · {hold.reason}</p>
      {hold.release_reason && <p>{hold.release_reason}</p>}
      {manage && hold.status === "ACTIVE" && !edit && <Button disabled={change.isPending} onClick={() => choose(hold)}>{t("audit.vault.release")}</Button>}
    </li>)}</ul> : <p>{t("audit.vault.noHolds")}</p>}
    {manage && !edit && <Button disabled={change.isPending} onClick={() => choose()}>{t("audit.vault.apply")}</Button>}
    {manage && edit && <Composer key={edit.hold?.id ?? "new"} layout="inline" headingLevel={4}
      title={edit.hold ? t("audit.vault.releaseFor", { case: edit.hold.case_ref }) : t("audit.vault.apply")}
      action={{ kind: "evidenceHold", mode: edit.hold ? "end" : "apply" }} pending={change.isPending}
      onClose={() => { change.reset(); setEdit(undefined); }} onSubmit={submit}>
      {edit.hold ? <Field required label={t("audit.vault.approval")} hint={t("audit.vault.approvalHint")} error={tried && !validApproval ? t("audit.vault.approvalHint") : undefined}>{props =>
        <TextInput {...props} value={edit.approval} onChange={e => setEdit({ ...edit, approval: e.target.value })} name="approval" />}</Field>
        : <>
          <Field required label={t("audit.vault.case")} error={tried && !edit.caseRef.trim() ? t("audit.vault.required") : undefined}>{props => <TextInput {...props} name="case" maxLength={200} value={edit.caseRef} onChange={e => setEdit({ ...edit, caseRef: e.target.value })} />}</Field>
          <Field required label={t("audit.vault.basis")} error={tried && !edit.basis.trim() ? t("audit.vault.required") : undefined}>{props => <TextInput {...props} name="basis" maxLength={2000} value={edit.basis} onChange={e => setEdit({ ...edit, basis: e.target.value })} />}</Field>
        </>}
      <Field required label={t("audit.vault.reason")} error={tried && !edit.reason.trim() ? t("audit.vault.required") : undefined}>{props => <TextInput {...props} name="reason" maxLength={2000} value={edit.reason} onChange={e => setEdit({ ...edit, reason: e.target.value })} />}</Field>
    </Composer>}
    {change.error && <CommandError error={change.error} own={code => code === "four_eyes_required" ? t("audit.vault.approvalHint") : undefined} />}
    {change.isSuccess && <p role="status">{t(change.data.status === "ACTIVE" ? "audit.vault.applied" : "audit.vault.released")}</p>}
  </RecordPaneSection>;
}
