// SPDX-License-Identifier: LicenseRef-Proprietary
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { PayrollOutlookLink } from "./payroll-outlook-link";
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
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { payGroupsQuery, payrollRunsPages, type PayGroup } from "../api";
import { payDateRule, periodRule, runStatus, runName } from "../present";
import { PayrollHomeConsole } from "./payroll-home-console";

export function PayrollHome() {
  const router = useRouter();
  const setupAccess = router.routesByPath["/payroll/setup"].options.staticData?.access;
  const createAccess = router.routesByPath["/payroll/runs/new"].options.staticData?.access;
  return (
    <PayrollHomeConsole
      setupAccess={setupAccess}
      createAccess={createAccess}
      baseline={() => <BaselinePayrollHome setupAccess={setupAccess} createAccess={createAccess} />}
    />
  );
}

function BaselinePayrollHome({ setupAccess, createAccess }: { setupAccess: unknown; createAccess: unknown }) {
  const groups = useQuery(payGroupsQuery);
  const access = useQuery(myAccessQuery);
  const add = access.data && setupAccess && (setupAccess === "signed-in" || accessRefusal(access.data, setupAccess as never) === null)
    ? <Link to="/payroll/setup">{t("payroll.setup.add")}</Link> : undefined;
  const create = access.data && createAccess && (createAccess === "signed-in" || accessRefusal(access.data, createAccess as never) === null)
    ? <Link to="/payroll/runs/new">{t("payroll.create.title")}</Link> : undefined;
  return <Page floorplan="P-01" head={{ title: t("payroll.title"), sub: t("payroll.alpha"), primary: create ?? add, tools: <><PayrollOutlookLink /><Link to="/payroll/reference" search={{ entity: undefined }}>{t("payroll.reference.title")}</Link></> }}>
    <QueryState q={groups} layout="list">{data => data.items.length ? <div className="form">
      {data.items.map(group => <Card key={group.id} title={group.name} meta={data.legal_entities.find(entity => entity.id === group.legal_entity_id)?.name}>
        <div className="form"><KeyValue readOnly items={[
          { key: "payDateRule", label: t("payroll.payDateRule"), value: payDateRule(group.pay_date_rule) },
          { key: "basePeriod", label: t("payroll.basePeriod"), value: periodRule(group.base_period) },
          { key: "variablePeriod", label: t("payroll.variablePeriod"), value: periodRule(group.variable_period) },
          { key: "proration", label: t("payroll.proration"), value: t(`payroll.rule.${group.proration}`) },
          { key: "channel", label: t("payroll.channel"), value: t(`payroll.rule.${group.channel}`) },
          { key: "sensitive", label: t("payroll.sensitive"), value: t(group.sensitive === null ? "payroll.rule.unknown" : group.sensitive ? "payroll.rule.sensitive.true" : "payroll.rule.sensitive.false") },
          { key: "payBasisAllowed", label: t("payroll.payBasisAllowed"), value: group.pay_basis_allowed?.map(basis => t(`payroll.rule.${basis}`)).join(" · ") ?? t("payroll.rule.unknown") },
        ]} />
        <GroupRuns group={group} />
        </div>
      </Card>)}
    </div> : <SetupRail title={t("payroll.setup.title")} summary={t("payroll.setup.reason")} groups={[{ key: "payroll", title: t("payroll.title"), steps: [
      { key: "entity", title: t("payroll.setup.entity"), state: data.legal_entities.length ? "done" : "todo", detail: t("payroll.setup.entityDetail") },
      { key: "group", title: t("payroll.setup.group"), state: "todo", action: add, detail: t("payroll.setup.groupDetail") },
      { key: "reference", title: t("payroll.setup.reference"), state: "todo", action: <Link to="/payroll/reference" search={{ entity: undefined }}>{t("payroll.reference.title")}</Link>, detail: t("payroll.setup.referenceDetail") },
    ] }]} />}</QueryState>
  </Page>;
}
function GroupRuns({ group }: { group: PayGroup }) {
  const runs = useInfiniteQuery(payrollRunsPages({ pay_group_id: group.id, legal_entity_id: group.legal_entity_id }));
  return <QueryState q={runs} layout="list">{data => {
    const rows = data.pages.flatMap(page => page.items).filter(run => run.pay_group_id === group.id && run.legal_entity_id === group.legal_entity_id);
    const total = data.pages[0]?.total ?? rows.length;
    return rows.length ? <LongTable label={t("payroll.runs", { name: group.name })} empty={null} rows={rows} total={total} rowId={run => run.id} hasMore={Boolean(runs.hasNextPage)} loadingMore={runs.isFetchingNextPage} onLoadMore={() => void runs.fetchNextPage()} columns={[
      { id: "period", header: t("payroll.period"), cell: run => `${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}`, rowHeader: true },
      { id: "name", header: t("payroll.runName"), cell: run => <Link to="/payroll/runs/$id" params={{ id: run.id }}>{runName(run, group)}</Link> },
      { id: "status", header: t("payroll.status"), card: "status", cell: run => <Chip>{runStatus(run.status)}</Chip> },
    ]} /> : <EmptyState title={t("payroll.noRuns")} reason={t("payroll.noRunsReason")} />;
  }}</QueryState>;
}
