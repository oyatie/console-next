// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import type { SinglePickRender } from "../../../reference/entity/ui/pick-one";
import { PlacementFields, type Placement } from "../../../reference/entity/ui/placement-fields";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { mapCompany, unmappedCompaniesQuery } from "../api";
import s from "./unplaced-console.module.css";

/** One company name: the entity and workplace it stands for, applied to every person with that name at once. */
function Row({ text, people, consoleMode = false, renderSingle }: { text: string; people: number; consoleMode?: boolean; renderSingle?: SinglePickRender }) {
  const [place, setPlace] = useState<Placement>({ legalEntityId: null, workplaceId: null, homeBranchId: null });
  const run = useCommand({
    run: (_: undefined, key: string) => mapCompany(key, { company_text: text, legal_entity_id: place.legalEntityId!, workplace_id: place.workplaceId! }),
    invalidates: ["/api/v1/employment-assignments", "/api/v1/employees", "/api/v1/onboarding", "/api/v1/org-units", "/api/v1/org-structure", "/api/v1/legal-entities"],
    announce: (r) => t("setup.names.mapped", { name: text, count: r.mapped }),
  });
  const ready = Boolean(place.legalEntityId && place.workplaceId);
  const action = ready ? (
    <Button variant="primary" className={consoleMode ? s.nowrap : undefined} disabled={run.isPending} onClick={() => run.mutate(undefined)}>
      {t("setup.names.apply", { count: people })}
    </Button>
  ) : (
    <DisabledReason
      layout="inline"
      reason={t("setup.names.choose")}
      control={(p) => (
        <Button variant="primary" {...p} className={consoleMode ? s.nowrap : undefined}>
          {t("setup.names.apply", { count: people })}
        </Button>
      )}
    >
      {consoleMode
        ? ({ control, reason }) => (
            <>
              {control}
              {reason}
            </>
          )
        : undefined}
    </DisabledReason>
  );
  if (consoleMode) {
    return (
      <li aria-label={text}>
        <RecordPaneSection title={t("setup.names.row", { name: text, count: people })}>
          <div className={s.mappingBody}>
            <div className={s.mappingFields}>
              <PlacementFields value={place} onChange={setPlace} renderSingle={renderSingle} />
            </div>
            <CommandError error={run.error} />
            <div className={s.mappingActions}>{action}</div>
          </div>
        </RecordPaneSection>
      </li>
    );
  }
  return (
    <li className="card panel form" aria-label={text}>
      <h2 className="panel__title">{t("setup.names.row", { name: text, count: people })}</h2>
      <div className="grid-3">
        <PlacementFields value={place} onChange={setPlace} />
      </div>
      <CommandError error={run.error} />
      <div className="form__actions">{action}</div>
    </li>
  );
}

/** Legacy import values are mapped where people are placed, once per value. */
export function CompanyMappings({
  consoleMode = false,
  renderSingle,
  wrapSection,
}: {
  consoleMode?: boolean;
  renderSingle?: SinglePickRender;
  wrapSection?: (children: ReactNode) => ReactNode;
}) {
  const q = useQuery(unmappedCompaniesQuery);
  return <QueryState q={q}>{(d) => d.items.length > 0 ? (
    consoleMode && wrapSection ? (
      wrapSection(
        <ul className="list-plain">{d.items.map((x) => <Row key={x.company_text} text={x.company_text} people={x.employees} consoleMode renderSingle={renderSingle} />)}</ul>,
      )
    ) : (
      <section aria-label={t("setup.names.title")}>
        <h2 className="panel__title">{t("setup.names.title")}</h2>
        <ul className="list-plain">{d.items.map((x) => <Row key={x.company_text} text={x.company_text} people={x.employees} />)}</ul>
      </section>
    )
  ) : null}</QueryState>;
}
