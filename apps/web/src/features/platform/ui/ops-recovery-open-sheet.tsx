import { QueryState } from "../../../lib/react/query-state";
// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectField } from "../../../ui/select/select-field";
import { recoveryQuery, recoveryWrite, type Org, type OpsRecoveryRead } from "../api";

export function OpsRecoveryOpenSheet({ org, data, onClose }: { org: Org; data: OpsRecoveryRead; onClose: () => void }) {
  const [role, setRole] = useState<"REPRESENTATIVE" | "SECURITY_CONTACT" | null>(null);
  const [name, setName] = useState("");
  const [method, setMethod] = useState("");
  const [evidence, setEvidence] = useState("");
  const [tried, setTried] = useState(false);
  const latest = useQuery(recoveryQuery(org.id));
  const facts = latest.data ?? data;
  const open = useCommand({
    run: (_: void, key: string) => recoveryWrite(org, "", {
      action: "open", authoriser_role: role!, authoriser_name: name.trim(),
      proofing_method: method.trim(), evidence_ref: evidence.trim(),
    }, key),
    invalidates: ["/api/platform"],
    onSuccess: onClose,
  });
  const required = (value: string | null) => tried && !value?.trim() ? t("opsRecovery.required") : undefined;
  const submit = () => {
    setTried(true);
    if (role && name.trim() && method.trim() && evidence.trim()) open.mutate(undefined);
  };
  return <Dialog open title={t("opsRecovery.open")} onClose={onClose} dismissable={!name && !method && !evidence && !open.isPending}>
    <Form className="form" onSubmit={submit} noValidate>
      <p>{t("opsRecovery.consequence", { hours: facts.hold_hours })} {t("opsRecovery.evidenceHint")} {t("opsRecovery.proofingHint")} {facts.active_accounts <= 1 && t("opsRecovery.solo")}</p>
      <SelectField label={t("opsRecovery.authoriserRole")} placeholder={t("opsRecovery.pickRole")}
        value={role} onChange={(id) => { if (id === "REPRESENTATIVE" || id === "SECURITY_CONTACT") setRole(id); }}
        options={[{ id: "REPRESENTATIVE", label: t("opsRecovery.representative") }, { id: "SECURITY_CONTACT", label: t("opsRecovery.securityContact") }]}
        error={required(role)} />
      <Field label={t("opsRecovery.authoriserName")} required error={required(name)}>
        {(p) => <TextInput {...p} value={name} onChange={(e) => setName(e.target.value)} disabled={open.isPending} />}
      </Field>
      <Field label={t("opsRecovery.proofingMethod")} required error={required(method)}>
        {(p) => <TextInput {...p} value={method} onChange={(e) => setMethod(e.target.value)} disabled={open.isPending} />}
      </Field>
      <Field label={t("opsRecovery.evidenceRef")} required error={required(evidence)}>
        {(p) => <TextInput {...p} value={evidence} maxLength={200} onChange={(e) => setEvidence(e.target.value)} disabled={open.isPending} />}
      </Field>
      {latest.error && <QueryState q={latest}>{() => null}</QueryState>}
      <CommandError error={open.error} />
      <div className="form__actions">
        <Button onClick={onClose} disabled={open.isPending}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={open.isPending || latest.isFetching || Boolean(latest.error)}>{t("opsRecovery.open")}</Button>
      </div>
    </Form>
  </Dialog>;
}
