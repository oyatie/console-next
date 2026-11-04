// SPDX-License-Identifier: LicenseRef-Proprietary
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Card } from "../../../ui/card/card";
import { ReceiptReference } from "../../../ui/composer/receipt-reference";
import s from "./account.module.css";

export function PrivacyReceipt({ request }: { request: PrivacyRightsReceipt }) {
  return <div className={s.pad}>
    <ReceiptReference value={request.receipt_no} />
    <KeyValue readOnly items={[
      { key: "controller", label: t("account.privacy.controller"), value: request.controller_label },
      { key: "kinds", label: t("account.privacy.kinds"), value: request.kinds.map(kind => kind.label).join(" · ") },
      { key: "status", label: t("account.privacy.status"), value: request.status.label },
      { key: "received", label: t("account.privacy.received"), value: fmtDateTime(request.received_at) },
      { key: "due", label: t("account.privacy.due"), value: request.clock
        ? <DeadlineChip days={request.clock.days_left} severity={request.clock.severity}>{fmtDateTime(request.clock.due_at)}</DeadlineChip>
        : t("account.privacy.noClock") },
      { key: "detail", label: t("account.privacy.detail"), value: <span className={s.notice}>{request.detail || t("account.privacy.noDetail")}</span> },
      ...(request.notified_at ? [{ key: "notified", label: t("account.privacy.notified"), value: fmtDateTime(request.notified_at) }] : []),
    ]} />
    {request.outcomes.map((outcome, index) => <Card key={index} title={outcome.kind_label} level={3} look="muted">
      <KeyValue readOnly items={[
        { key: "outcome", label: t("account.privacy.outcome"), value: outcome.outcome_label },
        ...(outcome.reason_label ? [{ key: "reason", label: t("account.privacy.reason"), value: outcome.reason_label }] : []),
        ...(outcome.note ? [{ key: "note", label: t("account.privacy.note"), value: <span className={s.notice}>{outcome.note}</span> }] : []),
      ]} />
    </Card>)}
    {request.outcomes.length > 0 && <KeyValue readOnly items={[
      { key: "objection", label: t("account.privacy.objection"), value: request.objection_method ?? t("account.privacy.objectionPending") },
    ]} />}
    <p className={`muted ${s.notice}`}>{request.retention_notice ?? t("account.privacy.retentionPending")}</p>
  </div>;
}
