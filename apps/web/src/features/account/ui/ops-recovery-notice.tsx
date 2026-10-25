import { QueryState } from "../../../lib/react/query-state";
// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Card } from "../../../ui/card/card";
import { Dialog } from "../../../ui/dialog";
import { claims, tenantRecoveryQuery, cancelTenantRecovery } from "../api";

export function OpsRecoveryNotice() {
  const q = useQuery(tenantRecoveryQuery);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const cancel = useCommand({
    run: (_: void, key: string) => cancelTenantRecovery(claims()!.org, q.data!.request!.id, reason.trim(), key),
    invalidates: ["/api/v1/tenant/ops-recovery"],
    onSuccess: () => { setCancelling(false); setReason(""); },
  });
  const r = q.data?.request;
  if (!r) return <QueryState q={q}>{() => null}</QueryState>;
  const active = q.data?.state === "WAITING_APPROVAL" || q.data?.state === "HOLD";
  return <QueryState q={q}>{() => <Card title={t("opsRecovery.title")} titleId="account-ops-recovery">
    <p>{t("opsRecovery.tenantOpenedBy", { actor: r.requested_by_name ?? t("opsRecovery.operator") })} {r.hold_until && t("opsRecovery.holdUntil", { at: fmtDateTime(r.hold_until) })} {active ? t("opsRecovery.tenantNotice") : q.data?.state === "CANCELLED" ? t("opsRecovery.cancelled", { actor: r.cancelled_by_name ?? t("opsRecovery.operator"), reason: r.cancel_reason ?? "—" }) : q.data?.state === "ISSUED" ? t("opsRecovery.issued", { minutes: q.data.code_ttl_minutes }) : t("opsRecovery.ready")}</p>
    {active && <Button onClick={() => setCancelling(true)}>{t("opsRecovery.cancel")}</Button>}
    {cancelling && <Dialog open title={t("opsRecovery.cancel")} onClose={() => setCancelling(false)} dismissable={!reason && !cancel.isPending}>
      <Form className="form" onSubmit={() => { setTried(true); if (reason.trim()) cancel.mutate(undefined); }} noValidate>
        <Field label={t("opsRecovery.cancelReason")} required error={tried && !reason.trim() ? t("opsRecovery.required") : undefined}>
          {(p) => <TextArea {...p} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <CommandError error={cancel.error} />
        <div className="form__actions"><Button onClick={() => setCancelling(false)} disabled={cancel.isPending}>{t("common.back")}</Button><Button type="submit" variant="primary" disabled={cancel.isPending}>{t("opsRecovery.cancel")}</Button></div>
      </Form>
    </Dialog>}
  </Card>}</QueryState>;
}
