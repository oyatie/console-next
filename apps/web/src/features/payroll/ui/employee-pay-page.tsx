// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Page } from "../../../ui/page/page";
import { EmptyState } from "../../../ui/empty-state";
import { Form, Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { DateInput } from "../../../ui/date/date-input";
import { payslipDraftQuery } from "../api";
import { ContractWageForm } from "./contract-wage-form";
import { PayslipDraftView } from "./payslip-draft";
const route = getRouteApi("/app/payroll/employees/$employeeId");
export function EmployeePayPage() {
  const { employeeId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [period, setPeriod] = useState(search.period ?? "");
  const [payDate, setPayDate] = useState(search.pay_date ?? "");
  return <Page floorplan="P-02" head={{ title: t("payroll.employee.title"), tools: <Link to="/people/$id" params={{ id: employeeId }}>{t("payroll.employee.person")}</Link> }}>
    <Form className="form" aria-label={t("payroll.employee.preview")} onSubmit={() => void navigate({ search: { period, pay_date: payDate } })}>
      <div className="grid-3"><Field label={t("payroll.period")} required>{control => <TextInput {...control} type="month" value={period} onChange={event => setPeriod(event.target.value)} />}</Field>
      <Field label={t("payroll.setup.day")} required>{control => <DateInput {...control} value={payDate} onChange={setPayDate} />}</Field></div>
      <div className="form__actions"><Button type="submit">{t("payroll.employee.preview")}</Button></div>
    </Form>
    {search.period && search.pay_date ? <Draft employeeId={employeeId} period={search.period} payDate={search.pay_date} /> : <EmptyState title={t("payroll.employee.pick")} reason={t("payroll.employee.pickReason")} />}
  </Page>;
}
function Draft({ employeeId, period, payDate }: { employeeId: string; period: string; payDate: string }) {
  const draft = useQuery(payslipDraftQuery(employeeId, period, payDate));
  const [record, setRecord] = useState(false);
  return <QueryState q={draft} layout="record">{data => <><PayslipDraftView data={data} />
    {record ? <ContractWageForm employeeId={employeeId} onClose={() => setRecord(false)} /> : <Button onClick={() => setRecord(true)}>{t("payroll.employee.record")}</Button>}
  </>}</QueryState>;
}
