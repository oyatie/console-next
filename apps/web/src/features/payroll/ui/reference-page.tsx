// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Page } from "../../../ui/page/page";
import { EmptyState } from "../../../ui/empty-state";
import { SelectField } from "../../../ui/select/select-field";
import { payGroupsQuery, payrollRatesQuery } from "../api";
import { ReferenceRegister } from "./reference-register";

export function PayrollReference() {
  const groups = useQuery(payGroupsQuery);
  const { entity } = useSearch({ from: "/app/payroll/reference" });
  const navigate = useNavigate({ from: "/payroll/reference" });
  return <Page floorplan="list" head={{ title: t("payroll.reference.title"), sub: t("payroll.reference.reason"), tools: <Link to="/payroll">{t("payroll.title")}</Link> }}>
    <QueryState q={groups} layout="list">{data => <div className="form">
      <SelectField label={t("payroll.entity")} placeholder={t("payroll.reference.pick")} value={entity ?? null} options={data.legal_entities.map(row => ({ id: row.id, label: row.name }))} onChange={id => void navigate({ search: { entity: id }, replace: true })} />
      {entity && data.legal_entities.some(row => row.id === entity) ? <Rates key={entity} entity={entity} /> : <EmptyState title={t("payroll.reference.pick")} reason={t("payroll.reference.pickReason")} />}
    </div>}</QueryState>
  </Page>;
}
function Rates({ entity }: { entity: string }) {
  const rates = useQuery(payrollRatesQuery(entity));
  return <QueryState q={rates} layout="list">{data => <ReferenceRegister data={data} />}</QueryState>;
}
