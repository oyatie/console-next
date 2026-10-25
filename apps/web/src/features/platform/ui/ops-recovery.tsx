// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { operatorId, recoveryWrite, type Issued, type Org, type OpsRecoveryRead, type RecoveryCommand } from "../api";
import { recoveryAction } from "../domain/ops-recovery";
import { OpsRecoveryOpenSheet } from "./ops-recovery-open-sheet";
import s from "./tenants.module.css";

export function OpsRecovery({ org, data, onIssued }: { org: Org; data: OpsRecoveryRead; onIssued: (issued: Issued) => void }) {
  const [opening, setOpening] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const request = data.request;
  const [clock, setClock] = useState(Date.now);
  const holdUntil = data.state === "HOLD" ? request?.hold_until : null;
  useEffect(() => {
    if (!holdUntil) return;
    // One local state transition at the server's hold boundary; no network refresh.
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, Date.parse(holdUntil) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [holdUntil]);
  const user = operatorId();
  const requester = Boolean(user && request?.requested_by === user);
  const party = Boolean(user && (requester || request?.approved_by === user));
  const primary = recoveryAction(data.state, data.recovery_available, data.second_operator_available, data.state === "WAITING_APPROVAL" ? requester : party, org.status === "ACTIVE", holdUntil, clock);
  const write = useCommand({
    run: (command: RecoveryCommand, key: string) => recoveryWrite(org, request!.id, command, key),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: (result) => {
      setCancelling(false);
      setReason("");
      if (result.otp && result.expires_at) onIssued({ org: org.name, otp: result.otp, expiresAt: result.expires_at, recoveryMinutes: data.code_ttl_minutes });
    },
  });
  const refusal = (code: string) => {
    const id = `opsRecovery.refusal.${code}`;
    return isMessageId(id) ? t(id) : undefined;
  };
  const canCancel = party && request && data.state !== "CANCELLED" && data.state !== "ISSUED";
  const reasonText = primary === "inactive" ? t("opsRecovery.inactive") : primary === "notEnrolled" ? t("opsRecovery.notEnrolled")
    : primary === "noSecondOperator" ? t("opsRecovery.noSecondOperator")
      : primary === "otherOperator" ? t("opsRecovery.otherOperator")
        : primary === "notParty" ? t("opsRecovery.notParty") : undefined;
  return <section className={s.section} aria-labelledby="tenant-ops-recovery">
    <h3 id="tenant-ops-recovery" className={s.heading}>{t("opsRecovery.title")}</h3>
    {request && <p className={s.note}>
      {t("opsRecovery.openedBy", { actor: request.requested_by_name ?? t("opsRecovery.operator") })} {data.state === "WAITING_APPROVAL" && t("opsRecovery.waiting")}
      {request.hold_until && (data.state === "HOLD" || data.state === "READY") && <>{t("opsRecovery.holdUntil", { at: fmtDateTime(request.hold_until) })} {t("opsRecovery.cancellable")}</>}
      {primary === "issued" && t("opsRecovery.issued", { minutes: data.code_ttl_minutes })}
      {primary === "cancelled" && t("opsRecovery.cancelled", { actor: request.cancelled_by_name ?? t("opsRecovery.operator"), reason: request.cancel_reason ?? "—" })}
    </p>}
    {!cancelling && <CommandError error={write.error} own={refusal} />}
    <div className={s.actions}>
      {(primary === "open" || ((primary === "cancelled" || primary === "issued") && data.recovery_available && data.second_operator_available && org.status === "ACTIVE")) && <Button onClick={() => setOpening(true)}>{t("opsRecovery.open")}</Button>}
      {primary === "approve" && <Button disabled={write.isPending} onClick={() => write.mutate({ action: "approve" })}>{t("opsRecovery.approve")}</Button>}
      {primary === "issue" && <Button disabled={write.isPending} onClick={() => write.mutate({ action: "issue" })}>{t("opsRecovery.issue")}</Button>}
      {reasonText && <DisabledReason reason={reasonText} control={(p) => <Button {...p}>{data.state === "WAITING_APPROVAL" ? t("opsRecovery.approve") : data.state === "READY" ? t("opsRecovery.issue") : t("opsRecovery.open")}</Button>} />}
      {primary === "hold" && <DisabledReason reason={t("opsRecovery.hold")} control={(p) => <Button {...p}>{t("opsRecovery.issue")}</Button>} />}
      {canCancel && <Button disabled={write.isPending} onClick={() => { setTried(false); setCancelling(true); }}>{t("opsRecovery.cancel")}</Button>}
    </div>
    {opening && <OpsRecoveryOpenSheet org={org} data={data} onClose={() => setOpening(false)} />}
    {cancelling && <Dialog open title={t("opsRecovery.cancel")} onClose={() => setCancelling(false)} dismissable={!reason && !write.isPending}>
      <Form className="form" onSubmit={() => { setTried(true); if (reason.trim()) write.mutate({ action: "cancel", reason: reason.trim() }); }} noValidate>
        <Field label={t("opsRecovery.cancelReason")} required error={tried && !reason.trim() ? t("opsRecovery.required") : undefined}>
          {(p) => <TextArea {...p} value={reason} onChange={(e) => setReason(e.target.value)} disabled={write.isPending} />}
        </Field>
        <CommandError error={write.error} own={refusal} />
        <div className="form__actions">
          <Button onClick={() => setCancelling(false)} disabled={write.isPending}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={write.isPending}>{t("opsRecovery.cancel")}</Button>
        </div>
      </Form>
    </Dialog>}
  </section>;
}
