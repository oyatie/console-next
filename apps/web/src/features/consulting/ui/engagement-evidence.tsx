// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { KeyValue, type KeyValueItem } from "../../../ui/key-value/key-value";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import type { Engagement } from "../api";

type Fact = readonly [string, string | undefined];
function Entry({ title, facts }: { title: string; facts: Fact[] }) {
  const items: KeyValueItem[] = facts.flatMap(([label, value]) => value ? [{ key: label, label, value }] : []);
  return <div><h3>{title}</h3><KeyValue label={title} items={items} /></div>;
}

export function EngagementEvidence({ row }: { row: Engagement }) {
  const diagnoses = new Map(row.diagnostics.map(d => [d.id, d.summary]));
  const findings = new Map(row.findings.map(f => [f.id, f.statement]));
  const initiatives = new Map(row.initiatives.map(i => [i.id, i.title]));
  const noRecords = t("consulting.none");
  return <>
    <RecordPaneSection title={t("consulting.diagnostic")}>{row.diagnostics.length ? row.diagnostics.map(d =>
      <Entry key={d.id} title={d.summary} facts={[[t("consulting.document"), d.document_id], [t("consulting.recorded"), fmtDateTime(d.created_at)]]} />) : noRecords}</RecordPaneSection>
    <RecordPaneSection title={t("consulting.finding")}>{row.findings.length ? row.findings.map(f =>
      <Entry key={f.id} title={f.statement} facts={[[t("consulting.diagnostic"), diagnoses.get(f.diagnostic_id) ?? f.diagnostic_id],
        [t("consulting.evidence"), f.evidence_id], [t("consulting.document"), f.document_id], [t("consulting.recorded"), fmtDateTime(f.created_at)]]} />) : noRecords}</RecordPaneSection>
    <RecordPaneSection title={t("consulting.initiative")}>{row.initiatives.length ? row.initiatives.map(i =>
      <Entry key={i.id} title={i.title} facts={[[t("consulting.finding"), findings.get(i.finding_id) ?? i.finding_id],
        [t("consulting.hypothesis"), i.hypothesis], [t("consulting.kpi"), i.kpi_definition_id], [t("consulting.direction"), t(`consulting.${i.target_direction}`)],
        [t("consulting.recorded"), fmtDateTime(i.created_at)]]} />) : noRecords}</RecordPaneSection>
    <RecordPaneSection title={t("consulting.observation")}>{row.observations.length ? row.observations.map(o =>
      <Entry key={o.id} title={o.note} facts={[[t("consulting.initiative"), initiatives.get(o.initiative_id) ?? o.initiative_id],
        [t("consulting.kpi"), o.kpi_definition_id], [t("consulting.evidence"), o.evidence_id], [t("consulting.observed"), fmtDateTime(o.observed_at)]]} />) : noRecords}</RecordPaneSection>
  </>;
}
