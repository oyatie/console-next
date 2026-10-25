import { QueryState } from "../../../lib/react/query-state";
import { readGroup } from "../../../lib/react/query-view";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { assignmentsRef, entitiesRef } from "../../../reference/entity/api";
import { buttonClass } from "../../../ui/button/button-class";
import { entityName } from "../../../reference/entity/domain/names";

/**
 * The employer of record and place of work (design §3.9), from the effective-dated assignments by id, not from
 * the text copied at registration. Earlier placements (a move between workplaces or entities) are listed under
 * the current one. Renders `dt`/`dd` pairs for the profile's list.
 */
export function EmploymentPlacement({ employeeId, className }: { employeeId: string; className?: string }) {
  const q = useQuery(assignmentsRef(employeeId));
  const list = useQuery(entitiesRef);
  const entities = list.data?.items ?? [];
  const entityOf = (id?: string | null) => entityName(entities.find((e) => e.id === id)) || "—";
  const workplaceName = (id?: string | null) => entities.flatMap((e) => e.workplaces).find((w) => w.id === id)?.current?.name ?? "—";
  const items = q.data?.items ?? [];
  const now = items.find((a) => !a.valid_to) ?? items[0];
  const before = items.filter((a) => a !== now);
  return (
    <QueryState q={readGroup([q, list])}>{() => <dl className={className}>
      <dt>{t("people.field.legalEntity")}</dt>
      <dd>
        {now?.legal_entity_id ? <Link className={buttonClass("ghost")} to="/org/entities/$id" params={{ id: now.legal_entity_id }}><EntityName entity={entities.find((e) => e.id === now.legal_entity_id)} /></Link> : now ? t("people.field.entityUnmapped") : "—"}
      </dd>
      <dt>{t("people.field.workplace")}</dt>
      <dd>
        {now?.workplace_id && now.legal_entity_id ? (
          <Link className={buttonClass("ghost")} to="/org/entities/$id" params={{ id: now.legal_entity_id }} search={{ wp: now.workplace_id }}>{workplaceName(now.workplace_id)}</Link>
        ) : (
          now ? workplaceName(now.workplace_id) : "—"
        )}
        {now && <span className="muted num"> · {t("people.field.since", { date: fmtDate(now.valid_from) })}</span>}
        {before.length > 0 && (
          <ul className="list-plain muted">
            {before.map((a) => (
              <li key={a.valid_from} className="num">{t("people.field.placedBefore", { entity: entityOf(a.legal_entity_id), workplace: workplaceName(a.workplace_id), from: fmtDate(a.valid_from), to: a.valid_to ? fmtDate(a.valid_to) : "" })}</li>
            ))}
          </ul>
        )}
      </dd>
    </dl>}</QueryState>
  );
}
