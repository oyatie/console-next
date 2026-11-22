import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { EMPLOYEE_STATUS, labeled } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { Chip } from "../../../ui/chip";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { RecordPattern } from "../../../ui/patterns/record";
import { employeeRef } from "../api";
import { NumberCard } from "./number-card";
import { RrnCard } from "./rrn-card";
import s from "./identifiers.module.css";

const route = getRouteApi("/app/people/$id/identifiers");

/**
 * One person's identifiers: the employee number (changed with an effective date and a reason, the old one kept as an
 * alias that still finds them, and its history) and the resident registration number, masked unless revealed with a
 * reason. Reached from the person page.
 */
export function IdentifiersPage() {
  const { id } = route.useParams();
  const person = useQuery(employeeRef(id));
  const view = queryView(person);
  const refused = view === "denied" || view === "not-found";
  const d = refused ? undefined : person.data;
  const status = d ? labeled(EMPLOYEE_STATUS, d.employee.status ?? "UNKNOWN") : null;

  const renderBaseline = () => (
    <div className="page">
      <PageReadGate q={person} title={t("identifiers.title", { name: "" }).trim()} back={{ to: "/people", label: t("peopleJump.keys.group.roster") }}>
        {d && (
          <PageHead
            titleId="identifiers-title"
            title={t("identifiers.title", { name: d.employee.name })}
            crumbs={<Crumbs items={[<Link key="person" to="/people/$id" params={{ id }} search={{}}>{d.employee.name}</Link>]} />}
          />
        )}
        <QueryState q={person} back={{ to: "/people", label: t("peopleJump.keys.group.roster") }} layout="record">
          {(loaded) => (
            <>
              <NumberCard employee={loaded.employee} />
              <RrnCard employeeId={loaded.employee.id} employeeStatus={loaded.employee.status} who={[loaded.employee.name, loaded.employee.employee_number].filter(Boolean).join(" ")} />
            </>
          )}
        </QueryState>
      </PageReadGate>
    </div>
  );

  return (
    <RecordPattern
      q={person}
      back={{ to: "/people", label: t("peopleJump.keys.group.roster") }}
      baseline={renderBaseline}
      head={{
        title: d ? t("identifiers.title", { name: d.employee.name }) : t("identifiers.title", { name: "" }).trim(),
        titleId: "identifiers-title",
        crumbs: d ? <Crumbs items={[<Link key="person" to="/people/$id" params={{ id }} search={{}} className={s.crumbLink}>{d.employee.name}</Link>]} /> : undefined,
        meta: d && status ? (
          <>
            <bdi className="code">{d.employee.employee_number ?? t("identifiers.number.none")}</bdi>
            <Chip tone={status.tone}>{status.label}</Chip>
          </>
        ) : undefined,
      }}
      sections={
        d ? (
          <>
            <NumberCard employee={d.employee} />
            <RrnCard employeeId={d.employee.id} employeeStatus={d.employee.status} who={[d.employee.name, d.employee.employee_number].filter(Boolean).join(" ")} />
          </>
        ) : null
      }
      statusSegments={
        d && status
          ? [
              { id: "person", tone: "strong" as const, content: `${d.employee.name} ${d.employee.employee_number ?? ""}`.trim() },
              { id: "status", content: status.label },
            ]
          : undefined
      }
    />
  );
}
