import { QueryState } from "../../../lib/react/query-state";
import { readGroup } from "../../../lib/react/query-view";
import { rulesQuery } from "../api";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { entityNameText } from "../../../reference/entity/present";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { reasonCodesQuery } from "../../../lib/reason-codes";
import { checklistRef, entitiesRef } from "../../../reference/entity/api";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { scopes, type Scope } from "../domain/numbering";
import { RenumberCard } from "./renumber-card";
import { RulesCard } from "./rules-card";

/**
 * Employee numbering for the company: the rule per scope (tenant, legal entity, workplace; the most specific wins)
 * that numbers people registered or imported without a number, and, while the company is still in SETUP, renumbering
 * a scope's people in one job that can be undone. After go-live a number changes one person at a time.
 */
export function NumberingPage() {
  return <AccessGate domain="hr_basic" level="edit" tenant><NumberingWorkspace /></AccessGate>;
}

function NumberingWorkspace() {
  const entities = useQuery(entitiesRef);
  const rules = useQuery(rulesQuery);
  const phase = useQuery({ ...checklistRef, retry: false });
  // Read with the page so the renumber form opens whole.
  useQuery(reasonCodesQuery("employee_number_change"));
  const list: Scope[] = scopes(
    t("identifiers.scope.tenant"),
    (entities.data?.items ?? []).filter((e) => !e.closed_on).map((e) => ({
      id: e.id,
      name: entityNameText(e),
      workplaces: e.workplaces.filter((w) => !w.closed_on).map((w) => ({ id: w.id, name: w.current?.name ?? "" })),
    })),
  );
  return (
    <div className="page">
      <PageHead
        titleId="numbering-title"
        title={t("identifiers.numbering.title")}
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} />}
      />
      <QueryState q={readGroup([entities, rules, phase])} layout="form">{() => <>
        <RulesCard scopes={list} />
        <RenumberCard scopes={list} phase={phase.data!.phase} />
      </>}</QueryState>
    </div>
  );
}
