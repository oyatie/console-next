// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t, type MessageId } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { readGroup } from "../../../lib/react/query-view";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { Button } from "../../../ui/button/button";
import { KeyValue, type KeyValueItem } from "../../../ui/key-value/key-value";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { RecordPattern } from "../../../ui/patterns/record";
import { historyQuery, recordQuery, type Change, type Engagement } from "../api";
import { EngagementEvidence } from "./engagement-evidence";
import { availableChanges } from "../workflow";
import { EngagementChange } from "./change";

const route = getRouteApi("/app/consulting/engagements/$engagementId");
const events: Readonly<Record<string, MessageId>> = {
  "engagement.created": "consulting.event.engagement.created", "engagement.transitioned": "consulting.event.engagement.transitioned",
  "diagnostic.recorded": "consulting.event.diagnostic.recorded", "finding.recorded": "consulting.event.finding.recorded",
  "initiative.proposed": "consulting.event.initiative.proposed", "benefit.observed": "consulting.event.benefit.observed",
};

export function ConsultingEngagement() {
  const { engagementId } = route.useParams();
  const query = useQuery(recordQuery(engagementId));
  const history = useQuery(historyQuery(engagementId));
  const row = query.data;
  const canManage = useServedCapability("served_consulting_manage");
  const [kind, edit] = useState<Change["kind"]>();
  const actions = row && canManage ? availableChanges(row) : [];
  return <RecordPattern q={readGroup([query, history])} head={{ title: row?.title ?? t("consulting.detail"), titleId: "consulting-record" }}
    back={{ to: "/consulting", label: t("consulting.title") }}
    sections={row && <>
      <RecordPaneSection title={t("consulting.detail")}><KeyValue items={facts(row)} />
        {actions.map(action => <Button key={action} onClick={() => edit(action)}>{t(`consulting.${action}`)}</Button>)}</RecordPaneSection>
      <EngagementEvidence row={row} />
    </>}
    spine={<RecordPaneSection title={t("consulting.history")}><KeyValue empty={t("consulting.noHistory")}
      items={(history.data ?? []).map(h => ({ key: h.id, label: events[h.event_type] ? t(events[h.event_type]!) : h.event_type,
        value: <>{fmtDateTime(h.occurred_at)} {h.from_status && stageName(h.from_status)} {h.to_status && stageName(h.to_status)} {typeof h.payload.reason === "string" && h.payload.reason}</> }))} /></RecordPaneSection>}
    overlays={row && kind && actions.includes(kind) && <EngagementChange key={`${engagementId}:${kind}`} row={row} kind={kind} onClose={() => edit(undefined)} />} />;
}

function facts(row: Engagement): KeyValueItem[] {
  const items: KeyValueItem[] = [
    { key: "state", label: t("consulting.state"), value: t(`consulting.stage.${row.status}`) },
    { key: "customer", label: t("consulting.customer"), value: row.customer_id },
    { key: "version", label: t("consulting.version"), value: row.version },
    { key: "updated", label: t("consulting.updated"), value: fmtDateTime(row.updated_at) },
  ];
  for (const [field, value] of [["approval", row.approval_id], ["workflow", row.workflow_execution_id],
    ["document", row.customer_document_id], ["ontology", row.ontology_instance_id]] as const) {
    if (value) items.push({ key: field, label: t(`consulting.${field}`), value });
  }
  return items;
}

function stageName(status: string) {
  const known = ["DRAFT", "PROPOSED", "APPROVED", "IMPLEMENTED", "MEASURED", "SUSTAINED", "CORRECTIVE"] as const;
  const stage = known.find(item => item === status);
  return stage ? t(`consulting.stage.${stage}`) : status;
}
