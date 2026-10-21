import { EntityName } from "./entity-name";
import { entityNameText } from "../present";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { entitiesRef } from "../api";
import { PickOne } from "./pick-one";

export type Placement = { legalEntityId: string | null; workplaceId: string | null; homeBranchId: string | null };

/**
 * Where a person is employed (design §3.9, §6.3): the legal entity, then one of its workplaces, by id. Nothing
 * is preselected unless it is the only option, which is then a fact and labelled as such. A missing entity or
 * workplace is said with the action that creates it. The home branch is the workplace's own default branch.
 * sub-branches inside a workplace are not offered until the workplace read lists them.
 */
export function PlacementFields({ value, onChange, error }: { value: Placement; onChange: (p: Placement) => void; error?: { entity?: string; workplace?: string } }) {
  const list = useQuery(entitiesRef);
  const entities = (list.data?.items ?? []).filter((e) => !e.closed_on);
  const only = entities.length === 1 ? entities[0]!.id : null;
  const entityId = value.legalEntityId ?? only;
  const workplaces = (entities.find((e) => e.id === entityId)?.workplaces ?? []).filter((w) => !w.closed_on);
  const onlyWp = workplaces.length === 1 ? workplaces[0]! : null;
  const workplaceId = value.workplaceId ?? onlyWp?.id ?? null;
  const branch = (id: string | null) => workplaces.find((w) => w.id === id)?.default_branch_id ?? null;
  // The single option counts as chosen: report it upward once, so the form sends it.
  const missing = (only !== null && !value.legalEntityId) || (onlyWp !== null && entityId !== null && !value.workplaceId);
  useEffect(() => {
    if (missing) onChange({ legalEntityId: entityId, workplaceId, homeBranchId: branch(workplaceId) });
  });

  if (list.isSuccess && entities.length === 0)
    return (
      <p className="alert">
        {t("placement.noEntity")} <Link to="/org/entities/new" className="btn">{t("placement.noEntity.action")}</Link>
      </p>
    );
  return (
    <>
      <PickOne
        label={t("placement.entity")}
        group={t("placement.entity")}
        empty={t("placement.noMatch")}
        required
        options={entities.map((e) => ({ value: e.id, label: entityNameText(e), content: <EntityName entity={e} /> }))}
        value={entityId}
        onChange={(v) => onChange({ legalEntityId: v, workplaceId: null, homeBranchId: null })}
        error={error?.entity}
      />
      {entityId && list.isSuccess && workplaces.length === 0 ? (
        <p className="alert">
          {t("placement.noWorkplace")} <Link to="/org/entities/$id/workplaces/new" params={{ id: entityId }} className="btn">{t("placement.noWorkplace.action")}</Link>
        </p>
      ) : (
        entityId && (
          <PickOne
            label={t("placement.workplace")}
            group={t("placement.workplace")}
            empty={t("placement.noMatch")}
            required
            options={workplaces.map((w) => ({ value: w.id, label: w.current?.name ?? w.id, description: w.is_primary ? t("placement.primary") : undefined }))}
            value={workplaceId}
            onChange={(v) => onChange({ legalEntityId: entityId, workplaceId: v, homeBranchId: branch(v) })}
            error={error?.workplace}
          />
        )
      )}
    </>
  );
}
