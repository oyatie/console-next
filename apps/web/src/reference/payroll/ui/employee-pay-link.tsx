// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { myAccessQuery } from "../../authz/api";
import { accessRefusal } from "../../authz/domain/access";
import { modulesQuery, moduleReady } from "../../onboarding/api";
export function EmployeePayLink({ employeeId }: { employeeId: string }) {
  const access = useQuery(myAccessQuery);
  const modules = useQuery(modulesQuery);
  const need = useRouter().routesByPath["/payroll/employees/$employeeId"].options.staticData?.access;
  return access.data && need && need !== "signed-in" && !accessRefusal(access.data, need) && modules.data && moduleReady(modules.data, "payroll")
    ? <Link className="link" to="/payroll/employees/$employeeId" params={{ employeeId }} search={{ period: undefined, pay_date: undefined }}>{t("payroll.employee.title")}</Link> : null;
}
