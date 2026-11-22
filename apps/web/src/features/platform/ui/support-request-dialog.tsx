// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { supportRefusal } from "../../../reference/support-access/api";
import { Button, Check, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { SelectField } from "../../../ui/select/select-field";
import { requestSupportSession, type Org, type SupportStartOutcome } from "../api";
import {
  SUPPORT_DURATIONS,
  SUPPORT_REASON_CODES,
  SUPPORT_SCOPES,
  type SupportReasonCode,
  type SupportScope,
} from "../domain/support";
import s from "./platform-console.module.css";

const scopeText = (scope: string) => codeText(`accessCodes.domain.${scope}`, scope);

type RequestSupportProps = {
  open: boolean;
  orgs: readonly Org[];
  initialOrg: Org;
  onClose: () => void;
  onRequested: (res: { id: string }, targetOrgId: string) => void;
};

export function RequestSupportDialog(props: RequestSupportProps) {
  if (!props.open) return null;
  return <RequestSupportDialogBody {...props} />;
}

function RequestSupportDialogBody({ open, orgs, initialOrg, onClose, onRequested }: RequestSupportProps) {
  const [targetOrgId, setTargetOrgId] = useState(initialOrg.id);
  const [ticketRef, setTicketRef] = useState("");
  const [category, setCategory] = useState<SupportReasonCode>("INCIDENT");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState<Set<SupportScope>>(() => new Set(["org"]));
  const [durationSeconds, setDurationSeconds] = useState<number>(3600);
  const [tried, setTried] = useState(false);

  const submitCommand = useCommand({
    run: () =>
      requestSupportSession({
        id: crypto.randomUUID(),
        org_id: targetOrgId,
        ticket_ref: ticketRef.trim(),
        category,
        purpose: purpose.trim(),
        scope: [...scope],
        duration_seconds: durationSeconds,
      }),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: (res) => {
      const org = targetOrgId;
      setTicketRef("");
      setPurpose("");
      setTried(false);
      onRequested(res, org);
    },
  });

  const submit = () => {
    setTried(true);
    if (!ticketRef.trim() || !purpose.trim() || scope.size === 0) {
      announce(t("tenants.groups.form.required"));
      return;
    }
    submitCommand.mutate(undefined);
  };

  return (
    <Dialog open={open} title={t("tenants.support.request")} onClose={onClose} dismissable={!submitCommand.isPending}>
      <Form className="form" onSubmit={submit} noValidate>
        <bdi className="muted t-sm">{t("tenants.support.form.consequence")}</bdi>
        <SelectField
          label={t("tenants.support.selectOrg")}
          placeholder={t("tenants.support.pickOrg")}
          value={targetOrgId}
          onChange={setTargetOrgId}
          options={orgs.map((o) => ({ id: o.id, label: `${o.name} (${o.slug})` }))}
        />
        <Field label={t("tenants.support.form.ticketRef")} required error={tried && !ticketRef.trim() ? t("tenants.groups.form.required") : undefined}>
          {(p) => <TextInput {...p} maxLength={200} value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} />}
        </Field>
        <SelectField
          label={t("tenants.support.form.reasonCode")}
          placeholder={t("tenants.support.form.pickReasonCode")}
          value={category}
          onChange={(v) => setCategory(v as SupportReasonCode)}
          options={SUPPORT_REASON_CODES.map((code) => ({ id: code, label: t(`tenants.support.reasonCode.${code}`) }))}
        />
        <Field label={t("tenants.support.form.reason")} required error={tried && !purpose.trim() ? t("tenants.groups.form.required") : undefined}>
          {(p) => <TextArea {...p} maxLength={2000} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
        </Field>
        <div role="group" aria-label={t("tenants.support.form.scope")} className={s.checkGroup}>
          <strong className="t-sm">{t("tenants.support.form.scope")}</strong>
          {SUPPORT_SCOPES.map((sc) => (
            <Check
              key={sc}
              checked={scope.has(sc)}
              onChange={(checked) =>
                setScope((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(sc);
                  else next.delete(sc);
                  return next;
                })
              }
            >
              {scopeText(sc)}
            </Check>
          ))}
        </div>
        <SelectField
          label={t("tenants.support.form.duration")}
          placeholder={t("tenants.support.form.duration")}
          value={String(durationSeconds)}
          onChange={(v) => setDurationSeconds(Number(v))}
          options={SUPPORT_DURATIONS.map((sec) => ({
            id: String(sec),
            label: t("tenants.support.durationMinutes", { minutes: sec / 60 }),
          }))}
        />
        <PasskeyError error={submitCommand.error} own={supportRefusal} />
        <div className="form__actions">
          <Button onClick={onClose} disabled={submitCommand.isPending}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={submitCommand.isPending || scope.size === 0}>
            {t("tenants.support.request")}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

export function SupportTokenDialog({
  outcome,
  onClose,
}: {
  outcome: SupportStartOutcome | null;
  onClose: () => void;
}) {
  const copy = () => {
    if (!outcome) return;
    void navigator.clipboard.writeText(outcome.access_token).then(
      () => announce(t("tenants.support.tokenCopied")),
      () => announce(t("common.copyFailed")),
    );
  };
  return (
    <Dialog open={outcome !== null} title={t("tenants.support.tokenTitle")} onClose={onClose} dismissable={false}>
      {outcome ? (
        <div className={s.paneStack}>
          <bdi className="t-sm">{t("tenants.support.tokenNotice", { at: fmtDateTime(outcome.expires_at) })}</bdi>
          <div className={s.tokenBox} role="group" aria-label={t("tenants.support.tokenTitle")}>
            <code>{outcome.access_token}</code>
          </div>
          <div className="form__actions">
            <Button onClick={copy}>{t("tenants.support.copyToken")}</Button>
            <Button variant="primary" onClick={onClose}>{t("tenants.code.close")}</Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
