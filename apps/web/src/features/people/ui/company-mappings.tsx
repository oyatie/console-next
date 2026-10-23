// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { PlacementFields, type Placement } from "../../../reference/entity/ui/placement-fields";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { mapCompany, unmappedCompaniesQuery } from "../api";

/** One company name: the entity and workplace it stands for, applied to every person with that name at once. */
function Row({ text, people }: { text: string; people: number }) {
  const [place, setPlace] = useState<Placement>({ legalEntityId: null, workplaceId: null, homeBranchId: null });
  const run = useCommand({
    run: (_: undefined, key: string) => mapCompany(key, { company_text: text, legal_entity_id: place.legalEntityId!, workplace_id: place.workplaceId! }),
    invalidates: ["/api/v1/employment-assignments", "/api/v1/employees", "/api/v1/onboarding", "/api/v1/org-units", "/api/v1/org-structure", "/api/v1/legal-entities"],
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

/** Legacy import values are mapped where people are placed, once per value. */
export function CompanyMappings() {
  const q = useQuery(unmappedCompaniesQuery);
  return <QueryState q={q}>{(d) => d.items.length > 0 ? (
    <section aria-label={t("setup.names.title")}>
      <h2 className="panel__title">{t("setup.names.title")}</h2>
      <ul className="list-plain">{d.items.map((x) => <Row key={x.company_text} text={x.company_text} people={x.employees} />)}</ul>
    </section>
  ) : null}</QueryState>;
}
