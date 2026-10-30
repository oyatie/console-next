// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Page } from "../../../ui/page/page";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { LongTable } from "../../../ui/long-table/long-table";
import { KeyValue } from "../../../ui/key-value/key-value";
import { SetupRail } from "../../../ui/setup-rail/setup-rail";
import { payGroupsQuery, payrollRunsQuery, type PayGroup } from "../api";
import { runStatus } from "../present";

export function PayrollHome() {
  const groups = useQuery(payGroupsQuery);
  return <Page floorplan="list" head={{ title: t("payroll.title"), sub: t("payroll.alpha"), tools: <Link to="/payroll/reference" search={{ entity: undefined }}>{t("payroll.reference.title")}</Link> }}>
    <QueryState q={groups} layout="list">{data => data.items.length ? <div className="form">
      <Card title={t("payroll.deadlines")}><ul>{data.items.map(group => <li key={group.id}>{group.name} · {t("payroll.nextPay", { date: fmtDate(group.next_pay_date) })}</li>)}</ul></Card>
      {data.items.map(group => <Card key={group.id} title={group.name} meta={data.legal_entities.find(entity => entity.id === group.legal_entity_id)?.name}>
        <div className="form"><KeyValue readOnly items={[
          { key: "payDateRule", label: t("payroll.payDateRule"), value: group.pay_date_rule },
          { key: "basePeriod", label: t("payroll.basePeriod"), value: group.base_period },
          { key: "variablePeriod", label: t("payroll.variablePeriod"), value: group.variable_period },
          { key: "proration", label: t("payroll.proration"), value: group.proration },
          { key: "channel", label: t("payroll.channel"), value: group.channel },
        ]} />
        <GroupRuns group={group} />
        </div>
      </Card>)}
    </div> : <SetupRail title={t("payroll.setup.title")} summary={t("payroll.setup.reason")} groups={[{ key: "payroll", title: t("payroll.title"), steps: [
      { key: "entity", title: t("payroll.setup.entity"), state: data.legal_entities.length ? "done" : "todo", detail: t("payroll.setup.entityDetail") },
      { key: "group", title: t("payroll.setup.group"), state: "todo", detail: t("payroll.setup.groupDetail") },
      { key: "reference", title: t("payroll.setup.reference"), state: "todo", action: <Link to="/payroll/reference" search={{ entity: undefined }}>{t("payroll.reference.title")}</Link>, detail: t("payroll.setup.referenceDetail") },
    ] }]} />}</QueryState>
  </Page>;
}
function GroupRuns({ group }: { group: PayGroup }) {
  const runs = useQuery(payrollRunsQuery);
  return <QueryState q={runs} layout="list">{data => {
    const rows = data.items.filter(run => run.pay_group_id === group.id && run.legal_entity_id === group.legal_entity_id);
    return rows.length ? <LongTable label={t("payroll.runs", { name: group.name })} empty={null} rows={rows} rowId={run => run.id} hasMore={false} onLoadMore={() => {}} columns={[
      { id: "period", header: t("payroll.period"), cell: run => `${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}`, rowHeader: true },
      { id: "name", header: t("payroll.runName"), cell: run => run.source_label },
      { id: "status", header: t("payroll.status"), card: "status", cell: run => <Chip>{runStatus(run.status)}</Chip> },
    ]} /> : <EmptyState title={t("payroll.noRuns")} reason={t("payroll.noRunsReason")} />;
  }}</QueryState>;
}
