// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";

export function SilenceAuditNotice({ receipt }: {
  receipt?: { silence_id: string; audit_recovery_ref?: string };
}) {
  if (!receipt?.audit_recovery_ref) return null;
  return <p role="alert">
    {COPY.alertActions.auditRecovery} {COPY.alerts.silences.id} <code>{receipt.silence_id}</code>
    {" · "}{COPY.o0.supportRefLabel} <code>{receipt.audit_recovery_ref}</code>
  </p>;
}
