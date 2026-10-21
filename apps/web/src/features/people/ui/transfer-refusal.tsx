import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { BlockedPanel } from "../../../ui/blocker/blocked-panel";
import { Button } from "../../../ui/button/button";
import { entitiesRef } from "../../../reference/entity/api";
import { unitsQuery } from "../../../reference/org/api";
import { entityName } from "../../../reference/entity/domain/names";

/** What a transfer_cross_entity refusal names (error.refusals[0]): the unit asked for and the legal entity it sits in. */
export type CrossEntity = { field?: string; value?: string; to_legal_entity_id?: string };

/**
 * A transfer into another legal entity, refused by the server (TR-33, decisions #30: that move is a group transfer). Says so in its own
 * sentence, names the unit and its legal entity, and offers either another unit of this legal entity or the group transfer sheet.
 */
export function TransferCrossEntity({ target, onFocusTarget, onGroupTransfer }: { target?: CrossEntity; onFocusTarget: () => void; onGroupTransfer?: () => void }) {
  const unit = useQuery(unitsQuery).data?.items.find((u) => u.id === target?.value)?.name;
  const entity = entityName(useQuery(entitiesRef).data?.items.find((e) => e.id === target?.to_legal_entity_id));
  return (
    <BlockedPanel
      kind="route"
      title={t("lifecycle.blocker.transfer_cross_entity")}
      code="transfer_cross_entity"
      unblockers={[{ name: t("lifecycle.blocker.you") }]}
      actions={
        <>
          <Button onClick={onFocusTarget}>{t("lifecycle.blocker.noop.fix.TRANSFER")}</Button>
          {onGroupTransfer && <Button onClick={onGroupTransfer}>{t("lifecycle.crossEntity.groupTransfer")}</Button>}
        </>
      }
    >
      {unit && entity ? t("lifecycle.crossEntity.target", { unit, entity }) : t("lifecycle.crossEntity.body")}
    </BlockedPanel>
  );
}
