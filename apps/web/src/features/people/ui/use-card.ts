import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { checklistRef, entitiesRef } from "../../../reference/entity/api";
import { unitsQuery } from "../../../reference/org/api";
import { unitPath } from "../../../reference/org/present";
import { useCan } from "../../../reference/authz/ui/use-can";
import { eventsQuery, factsQuery, jobTitlesQuery } from "../api";
import { personalFactsQuery, recordsQuery, registerFactsQuery } from "../api/record";
import { entityName } from "../../../reference/entity/domain/names";

type Detail = components["schemas"]["EmployeeDetail"];

/**
 * Every read the personnel card shows beside the employee itself. Each lands on its own: a section whose read is still
 * pending keeps its geometry, and one the server refuses says so in place (never the whole card).
 */
export function useCard(d: Detail) {
  const e = d.employee;
  const can = useCan();
  const manage = can("employee_directory_manage", "all");
  // The route waits for this read on arrival; mounting the card uses that answer.
  const events = useQuery({ ...eventsQuery(e.id), refetchOnMount: false });
  const personal = useQuery({ ...personalFactsQuery(e.id), enabled: manage, retry: false });
  const register = useQuery({ ...registerFactsQuery(e.id), enabled: manage, retry: false });
  const facts = useQuery({ ...factsQuery(e.id), enabled: manage, retry: false });
  const records = useQuery({ ...recordsQuery(e.id), enabled: manage, retry: false });
  const titles = useQuery({ ...jobTitlesQuery, enabled: manage }).data?.items ?? [];
  // The earliest reservation (a dated act not applied yet): the head's next-scheduled line and the tag on the field it changes.
  const planned = (events.data?.items ?? []).filter((x) => x.state === "SCHEDULED").sort((a, b) => a.effective_date.localeCompare(b.effective_date))[0];
  const units = useQuery(unitsQuery).data?.items ?? [];
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const phase = useQuery({ ...checklistRef, retry: false }).data?.phase;
  const unit = units.find((u) => u.id === e.org_unit_id);
  const entity = entities.find((x) => x.id === e.legal_entity_id);
  const workplace = entity?.workplaces.find((w) => w.id === e.workplace_id);
  // The department path below the workplace (production dept › production1team); the workplace itself is named on its own.
  const path = unit && unit.kind !== "SITE" ? unitPath(units, unit).split(" › ").slice(1) : [];
  return {
    d,
    e,
    manage,
    /** A reader who cannot change the record asks HR instead (BW-17). */
    request: !manage && can("employee_directory_read"),
    /** Who links accounts (the access tab). */
    users: can("user_manage"),
    events,
    personal,
    register,
    facts,
    records,
    planned,
    /** A grade, position, duty title, job or job family id as the tenant's list names it. */
    title: (id: string | null | undefined) => titles.find((x) => x.id === id)?.label,
    setup: phase === "SETUP",
    place: { entity: entityName(entity) || e.company, workplace: workplace?.current?.name ?? null, path },
  };
}
export type Card = ReturnType<typeof useCard>;
