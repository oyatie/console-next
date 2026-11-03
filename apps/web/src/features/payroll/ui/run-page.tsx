// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Page } from "../../../ui/page/page";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { StepLine } from "../../../ui/step-line/step-line";
import { payGroupsQuery, payrollRunQuery, type PayGroup, type PayrollRun } from "../api";
import { runStatus, runStages } from "../present";

export function PayrollRunPage() {
  const { id } = useParams({ from: "/app/payroll/runs/$id" });
  const detail = useQuery(payrollRunQuery(id));
  const groups = useQuery(payGroupsQuery);
  return <Page floorplan="P-02" head={{ title: !detail.isError && detail.data?.run.source_label || t("payroll.runName"), tools: <Link to="/payroll">{t("payroll.title")}</Link> }}>
    <QueryState q={detail} layout="list" back={{ to: "/payroll", label: t("payroll.title") }}>{data => <QueryState q={groups} layout="list">{choices => <RunHeader run={data.run} group={choices.items.find(group => group.id === data.run.pay_group_id && group.legal_entity_id === data.run.legal_entity_id)} entity={choices.legal_entities.find(entity => entity.id === data.run.legal_entity_id)?.name} />}</QueryState>}</QueryState>
  </Page>;
}
export function RunHeader({ run, group, entity }: { run: PayrollRun; group?: PayGroup; entity?: string | null }) {
  return <div className="form">
    <KeyValue readOnly items={[
      { key: "entity", label: t("payroll.entity"), value: entity ?? t("payroll.entityUnnamed") },
      { key: "group", label: t("payroll.group"), value: group?.name ?? t("payroll.rule.unknown") },
      { key: "period", label: t("payroll.period"), value: `${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}` },
      { key: "status", label: t("payroll.status"), value: <Chip>{runStatus(run.status)}</Chip> },
    ]} />
    <StepLine label={t("payroll.stages.title")} steps={runStages(run.status).map(step => ({ ...step, label: t(`payroll.stage.${step.key}`) }))} />
  </div>;
}
