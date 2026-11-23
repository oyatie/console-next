// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi, Link } from "@tanstack/react-router";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { t } from "@console/i18n";
import { PickOne } from "../../../reference/entity/ui/pick-one";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { FormRow, FormRowList, FormSection } from "../../../ui/patterns/form-section";

const route = getRouteApi("/app/org/paste");

export function PickRoot({ entities }: { entities: Node[] }) {
  const navigate = route.useNavigate();
  const pick = (v: string) => void navigate({ search: v.startsWith("e:") ? { entity: v.slice(2) } : { workplace: v.slice(2) } });
  const options = entities.flatMap((e) => [
    { value: `e:${e.id}`, label: e.name },
    ...e.children.filter((w) => w.kind === "WORKPLACE").map((w) => ({ value: `w:${w.id}`, label: t("orgBulk.import.sitePath", { entity: e.name, name: w.name }) })),
  ]);
  if (options.length === 0) {
    return (
      <FormSection>
        <EmptyState title={t("orgBulk.paste.noEntity")} reason={null} actions={<Link to="/org/entities/new" className={buttonClass("primary")}>{t("entity.empty.action")}</Link>} />
      </FormSection>
    );
  }
  return (
    <>
      <FormSection>
        <PickOne label={t("orgBulk.paste.pickRoot")} required options={options} value={null} onChange={pick} group={t("orgBulk.paste.pickRoot")} empty={t("orgBulk.paste.pickRootNone")} />
      </FormSection>
      <FormSection>
        <FormRowList label={t("orgBulk.paste.pickRoot")}>
          {entities.flatMap((e) => {
            const sites = e.children.filter((w) => w.kind === "WORKPLACE");
            return [
              <FormRow
                key={`e:${e.id}`}
                primary={<b>{e.name}</b>}
                secondary={t("entity.count.workplaces", { count: sites.length })}
                end={
                  <Link to="/org/paste" search={{ entity: e.id }} className={buttonClass("secondary", { size: "sm" })}>
                    {t("orgBulk.paste.title")}
                  </Link>
                }
              />,
              ...sites.map((w) => (
                <FormRow
                  key={`w:${w.id}`}
                  primary={t("orgBulk.import.sitePath", { entity: e.name, name: w.name })}
                  secondary={t("orgStructure.peopleCount", { count: w.headcount })}
                  end={
                    <Link to="/org/paste" search={{ workplace: w.id }} className={buttonClass("secondary", { size: "sm" })}>
                      {t("orgBulk.paste.title")}
                    </Link>
                  }
                />
              )),
            ];
          })}
        </FormRowList>
      </FormSection>
    </>
  );
}
