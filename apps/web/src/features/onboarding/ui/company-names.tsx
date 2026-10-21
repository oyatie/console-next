import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { PlacementFields, type Placement } from "../../../reference/entity/ui/placement-fields";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { mapCompany, SETUP_READS, unmappedCompaniesQuery } from "../api";

/** One company name: the entity and workplace it stands for, applied to every person with that name at once. */
function Row({ text, people }: { text: string; people: number }) {
  const [place, setPlace] = useState<Placement>({ legalEntityId: null, workplaceId: null, homeBranchId: null });
  const run = useCommand({
    run: (_: undefined, key: string) => mapCompany(key, { company_text: text, legal_entity_id: place.legalEntityId!, workplace_id: place.workplaceId! }),
    invalidates: SETUP_READS,
    announce: (r) => t("setup.names.mapped", { name: text, count: r.mapped }),
  });
  const ready = Boolean(place.legalEntityId && place.workplaceId);
  return (
    <li className="card panel form" aria-label={text}>
      <h2 className="panel__title">{t("setup.names.row", { name: text, count: people })}</h2>
      <div className="grid-3">
        <PlacementFields value={place} onChange={setPlace} />
      </div>
      <CommandError error={run.error} />
      <div className="form__actions">
        {ready ? (
          <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(undefined)}>{t("setup.names.apply", { count: people })}</Button>
        ) : (
          <DisabledReason layout="inline" reason={t("setup.names.choose")} control={(p) => <Button variant="primary" {...p}>{t("setup.names.apply", { count: people })}</Button>} />
        )}
      </div>
    </li>
  );
}

/**
 * Company-name cleanup (design §3.13): people recorded with a company name that no legal entity stands for are
 * mapped once per distinct name, never person by person, and never by fuzzy text.
 */
export function CompanyNames() {
  const q = useQuery(unmappedCompaniesQuery);
  return (
    <div className="page">
      <div className="page__head">
        <Link to="/" className="btn btn--ghost">{t("setup.title")}</Link>
        <h1 className="page__title" tabIndex={-1}>{t("setup.names.title")}</h1>
      </div>
      <QueryState q={q}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={t("setup.names.none.title")} reason={t("setup.names.none.reason")} actions={<Link to="/" className="btn btn--primary">{t("setup.org.done")}</Link>} />
          ) : (
            <>
              <ul className="list-plain">{d.items.map((x) => <Row key={x.company_text} text={x.company_text} people={x.employees} />)}</ul>
            </>
          )
        }
      </QueryState>
    </div>
  );
}
