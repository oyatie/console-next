import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup } from "../../../lib/react/query-view";
import { reasonCodesQuery } from "../../../lib/reason-codes";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { checklistRef, entitiesRef } from "../../../reference/entity/api";
import { entityNameText } from "../../../reference/entity/present";
import { SettingsViewsNav } from "../../../shell/settings-nav";
import { useSettingsViews } from "../../../shell/use-settings-views";
import { StatRow } from "../../../ui/key-value/key-value";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { rulesQuery } from "../api";
import { scopes, type Scope } from "../domain/numbering";
import { RenumberCard } from "./renumber-card";
import { RulesCard } from "./rules-card";
import s from "./identifiers.module.css";

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
  const navItems = useSettingsViews();
  const list: Scope[] = scopes(
    t("identifiers.scope.tenant"),
    (entities.data?.items ?? []).filter((e) => !e.closed_on).map((e) => ({
      id: e.id,
      name: entityNameText(e),
      workplaces: e.workplaces.filter((w) => !w.closed_on).map((w) => ({ id: w.id, name: w.current?.name ?? "" })),
    })),
  );
  const combinedQ = readGroup([entities, rules, phase]);

  const renderBaseline = () => (
    <div className="page">
      <PageHead
        titleId="numbering-title"
        title={t("identifiers.numbering.title")}
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} />}
      />
      <QueryState q={combinedQ} layout="form">
        {() => (
          <>
            <RulesCard scopes={list} />
            <RenumberCard scopes={list} phase={phase.data!.phase} />
          </>
        )}
      </QueryState>
    </div>
  );

  return (
    <SettingsPattern
      q={combinedQ}
      baseline={renderBaseline}
      head={{
        title: t("identifiers.numbering.title"),
        titleId: "numbering-title",
        crumbs: <Crumbs items={[<Link key="people" to="/people" search={{}} className={s.crumbLink}>{t("people.title")}</Link>]} />,
      }}
      views={navItems.length > 0 ? <SettingsViewsNav items={navItems} current="/people/numbering" /> : undefined}
      summary={
        <StatRow
          label={t("identifiers.numbering.title")}
          items={[
            { key: "scopes", label: t("identifiers.rules.col.scope"), value: fmtNumber(list.length) },
            { key: "rules", label: t("identifiers.rules.title"), value: fmtNumber((rules.data ?? []).length) },
          ]}
        />
      }
      panel={
        phase.data ? (
          <>
            <RulesCard scopes={list} />
            <RenumberCard scopes={list} phase={phase.data.phase} />
          </>
        ) : null
      }
      statusSegments={[
        { id: "scope", tone: "strong", content: t("identifiers.numbering.title") },
        { id: "rules", content: fmtNumber((rules.data ?? []).length) },
      ]}
    />
  );
}
