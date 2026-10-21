import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { employeeWarningText } from "../present";
import { Banner } from "../../../ui/banner/banner";
import { employeeQuery } from "../api";

type Warning = components["schemas"]["EmployeeCreateWarning"];

/** Registration receipts and the card show each typed notice with its own remedy. */
export function EmployeeWarnings({ warnings = [] }: { warnings?: readonly Warning[] }) {
  return warnings.map((warning) => <EmployeeWarning key={warning.code} warning={warning} />);
}

function EmployeeWarning({ warning: w }: { warning: Warning }) {
  const others = useQueries({ queries: w.employee_ids.map(employeeQuery) });
  return <Banner tone="warn" live="polite">
    {employeeWarningText(w)}
    {others.map((q, i) => q.data ? <Link key={w.employee_ids[i]} to="/people/$id" params={{ id: w.employee_ids[i]! }} search={{}}>
      {t("people.sameName.other", { name: q.data.employee.name, number: q.data.employee.employee_number ?? "—" })}
    </Link> : t("people.sameName.loading"))}
  </Banner>;
}
