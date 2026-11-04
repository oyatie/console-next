// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button, Form } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import {
  createPayrollRun,
  payGroupSchemas,
  payGroupsQuery,
  payrollRunPreviewQuery,
  type CreatePayrollRun,
} from "../api";

const kinds = payGroupSchemas.PayrollRunKind.enum.filter(kind => kind === "REGULAR");
const refusal = (code: string) => ({
  regular_run_exists: t("payroll.create.refuse.regular_run_exists"),
  forbidden: t("payroll.create.refuse.forbidden"),
  run_kind_unsupported: t("payroll.create.refuse.run_kind_unsupported"),
  phase_not_operating: t("payroll.create.refuse.phase_not_operating"),
}[code]);

export function PayrollRunCreatePage() {
  const groups = useQuery(payGroupsQuery);
  const [payGroupId, setPayGroupId] = useState<string | null>(null);
  const [kind, setKind] = useState<CreatePayrollRun["kind"] | null>(null);
  const input = payGroupId && kind ? { pay_group_id: payGroupId, kind } : null;
  return <Page floorplan="P-04" head={{ title: t("payroll.create.title"), sub: t("payroll.create.reason"), tools: <Link to="/payroll">{t("payroll.title")}</Link> }}>
    <QueryState q={groups} layout="form">{data => data.items.length ? <div className="form">
      <ChoiceField label={t("payroll.group")} required options={data.items.map(group => ({ value: group.id, label: `${group.name} · ${data.legal_entities.find(entity => entity.id === group.legal_entity_id)?.name ?? t("payroll.entityUnnamed")}` }))} value={payGroupId} onChange={setPayGroupId} />
      <ChoiceField label={t("payroll.create.kind")} required options={kinds.map(value => ({ value, label: t(`payroll.create.kind.${value}`) }))} value={kind} onChange={value => setKind(value as CreatePayrollRun["kind"])} />
      {input && <RunPreview input={input} />}
    </div> : <EmptyState title={t("payroll.create.noGroups")} reason={t("payroll.create.noGroupsReason")} actions={<Link to="/payroll/setup">{t("payroll.setup.add")}</Link>} />}</QueryState>
  </Page>;
}

function RunPreview({ input }: { input: CreatePayrollRun }) {
  const preview = useQuery({ ...payrollRunPreviewQuery(input), retry: false });
  const navigate = useNavigate();
  const create = useCommand({
    run: createPayrollRun,
    invalidates: ["/api/v1/payroll/runs"],
    announce: () => t("payroll.create.saved"),
    onSuccess: run => navigate({ to: "/payroll/runs/$id", params: { id: run.id } }),
  });
  return <QueryState q={preview} layout="form">{facts => <Form className="form" onSubmit={() => create.mutate(input)}>
    <KeyValue readOnly label={t("payroll.create.preview")} items={[
      { key: "month", label: t("payroll.create.month"), value: facts.attribution_month },
      { key: "payDate", label: t("payroll.create.payDate"), value: fmtDate(facts.pay_date) },
      { key: "base", label: t("payroll.basePeriod"), value: `${fmtDate(facts.period_start)} – ${fmtDate(facts.period_end)}` },
      { key: "variable", label: t("payroll.variablePeriod"), value: `${fmtDate(facts.variable_period_start)} – ${fmtDate(facts.variable_period_end)}` },
    ]} />
    <CommandError error={create.error} own={refusal} recover={false} />
    <div className="form__actions"><Button type="submit" variant="primary" disabled={create.isPending}>{t("payroll.create.submit")}</Button></div>
  </Form>}</QueryState>;
}
