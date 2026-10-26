import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { employeeRef } from "../api";
import { NumberCard } from "./number-card";
import { RrnCard } from "./rrn-card";

const route = getRouteApi("/app/people/$id/identifiers");

/**
 * One person's identifiers: the employee number (changed with an effective date and a reason, the old one kept as an
 * alias that still finds them, and its history) and the resident registration number, masked unless revealed with a
 * reason. Reached from the person page.
 */
export function IdentifiersPage() {
  const { id } = route.useParams();
  const person = useQuery(employeeRef(id));
  return (
    <div className="page"><PageReadGate q={person} title={t("identifiers.title", { name: "" }).trim()} back={{ to: "/people", label: t("peopleJump.keys.group.roster") }}>{person.data && <>
      <PageHead
        titleId="identifiers-title"
        title={t("identifiers.title", { name: person.data.employee.name })}
        crumbs={<Crumbs items={[<Link key="person" to="/people/$id" params={{ id }} search={{}}>{person.data.employee.name}</Link>]} />}
      />
    </>}
    <QueryState q={person} back={{ to: "/people", label: t("peopleJump.keys.group.roster") }} layout="record">{d => <>
      <>
            <NumberCard employee={d.employee} />
            <RrnCard employeeId={d.employee.id} who={[d.employee.name, d.employee.employee_number].filter(Boolean).join(" ")} />
      </>
    </>}</QueryState>
    </PageReadGate></div>
  );
}
