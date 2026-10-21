import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Dialog } from "../../../ui/dialog";
import { ENTITY_READS, voidEntity } from "../api";
import { entityName } from "../../../reference/entity/domain/names";

const REASONS = ["DUPLICATE", "TEST_ENTRY", "WRONG_DOCUMENT"] as const;

/**
 * Removing a mistaken legal entity while the tenant is still in setup (challenge B-2.1): its workplaces,
 * registrations and placements go with it, the evidence stays under retention, and the audit keeps the
 * reason. The server refuses once operations start or once anything outside setup depends on it.
 */
export function VoidEntity({ e, onClose }: { e: LegalEntity; onClose: () => void }) {
  const name = entityName(e);
  const nav = useNavigate();
  const [reason, setReason] = useState<string | null>(null);
  const run = useCommand({
    run: (_: undefined, key: string) => voidEntity(key, e.id, reason!),
    invalidates: ENTITY_READS,
    announce: () => t("entity.void.done", { name }),
    onSuccess: () => void nav({ to: "/org/entities" }),
  });
  return (
    <Dialog open title={t("entity.void.title")} onClose={onClose}>
      <p>{t("entity.void.consequence", { name, workplaces: e.workplaces.length, registrations: e.registrations.length })}</p>
      <ChoiceField label={t("entity.void.reason")} required options={REASONS.map((r) => ({ value: r, label: t(`entity.void.reason.${r}`) }))} value={reason} onChange={setReason} />
      <EntityError error={run.error} />
      <div className="form__actions">
        <Button onClick={onClose}>{t("common.back")}</Button>
        {reason ? <Button variant="danger" disabled={run.isPending} onClick={() => run.mutate(undefined)}>{t("entity.void.confirm")}</Button> : <DisabledReason layout="inline" reason={t("entity.void.reasonNeeded")} control={(p) => <Button variant="danger" {...p}>{t("entity.void.confirm")}</Button>} />}
      </div>
    </Dialog>
  );
}
