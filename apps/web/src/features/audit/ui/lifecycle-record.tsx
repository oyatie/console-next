// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordPattern } from "../../../ui/patterns/record";
import { RecordSection } from "../../../ui/record/record-section";
import { lifecycleQuery } from "../api";
import { lifecycleCode } from "../present";
import { LifecycleActions } from "./lifecycle-actions";

const route = getRouteApi("/app/audit/lifecycles/$objectType/$objectId");
export function LifecycleRecord() {
  const target = route.useParams();
  const q = useQuery(lifecycleQuery(target));
  const record = q.data;
  return <RecordPattern q={q} head={{ title: t("audit.lifecycle.title"), titleId: "lifecycle-title" }}
    tabs={<AuditTabs />} sections={record && <>
      <RecordSection id="lifecycle-state" title={t("audit.lifecycle.state")}>
        <KeyValue items={[
          { key: "target", label: t("audit.lifecycle.target"), value: record.objectType + " · " + record.objectId },
          { key: "state", label: t("audit.lifecycle.state"), value: lifecycleCode(record.currentState) },
          { key: "hold", label: t("audit.lifecycle.hold"), value: t(record.legalHold ? "audit.lifecycle.held" : "audit.lifecycle.clear") },
          { key: "until", label: t("audit.lifecycle.retention"), value: record.retentionUntil ? fmtDate(record.retentionUntil) : t("audit.lifecycle.noDate") },
        ]} />
        <LifecycleActions key={record.objectType + record.objectId} record={record} />
      </RecordSection>
      <RecordSection id="lifecycle-history" title={t("audit.lifecycle.history")}>
        {record.transitions.length ? <ol>{record.transitions.map((change, index) => <li key={change.occurredAt + index}>
          <strong>{t("audit.lifecycle.transition", { from: lifecycleCode(change.fromState), to: lifecycleCode(change.toState) })}</strong>
          <div>{change.reason}</div><time dateTime={change.occurredAt}>{fmtDateTime(change.occurredAt)}</time>
        </li>)}</ol> : <EmptyState title={t("audit.lifecycle.empty")} reason={null} />}
      </RecordSection>
    </>} />;
}
