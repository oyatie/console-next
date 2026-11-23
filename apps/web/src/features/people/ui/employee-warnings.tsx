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
  const matches = w.matches;
  const extra = matches !== undefined ? Math.max(0, (w.total_count ?? matches.length) - matches.length) : 0;
  return (
    <Banner tone="warn" live="polite">
      {employeeWarningText(w)}
      {matches !== undefined ? (
        <>
          {matches.map((m) => (
            <Link key={m.id} to="/people/$id" params={{ id: m.id }} search={{}}>
              {t("people.sameName.other", { name: m.name, number: m.employee_number ?? "—" })}
            </Link>
          ))}
          {extra > 0 ? <bdi>{t("people.sameName.more", { count: extra })}</bdi> : null}
        </>
      ) : w.employee_ids.length > 0 ? (
        <EmployeeWarningFallbackIds ids={w.employee_ids} />
      ) : null}
    </Banner>
  );
}

function EmployeeWarningFallbackIds({ ids }: { ids: readonly string[] }) {
  const others = useQueries({ queries: ids.map(employeeQuery) });
  return others.map((q, i) =>
    q.data ? (
      <Link key={ids[i]} to="/people/$id" params={{ id: ids[i]! }} search={{}}>
        {t("people.sameName.other", { name: q.data.employee.name, number: q.data.employee.employee_number ?? "—" })}
      </Link>
    ) : (
      t("people.sameName.loading")
    ),
  );
}
