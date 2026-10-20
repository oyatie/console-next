import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BusinessRegistration, LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { ownRefusal, refusalText } from "../../../reference/crud/present";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ENTITY_READS, entityEndQuery, readVersion, voidRegistration } from "../api";
import { fieldRefusal } from "../present";
import { EntityError } from "./entity-error";

const REASONS = ["DUPLICATE", "TEST_ENTRY", "WRONG_DOCUMENT"] as const;

/**
 * Setup-only removal of a mistaken business registration certificate (crud-g10): reads the entity's end-options to
 * preview what is deleted and whether any workplace still uses this certificate. Evidence stays under retention and the
 * reason is recorded in the audit log; the server refuses with 409 record_in_use when a workplace still references it.
 */
export function VoidRegistration({ e, r, onClose, error }: { e: LegalEntity; r: BusinessRegistration; onClose: () => void; error?: unknown }) {
  const name = r.brn?.display ?? r.current?.trade_name ?? t("entityRecord.cert.title");
  const end = useQuery({ ...entityEndQuery(e.id), retry: false }).data;
  const linked = e.workplaces.filter((w) => w.registration_id === r.id || w.id === r.holder_workplace_id);
  const [reason, setReason] = useState<string | null>(null);
  const run = useCommand({
    run: (_: undefined, key: string) => voidRegistration(key, r.id, reason!),
    invalidates: ENTITY_READS,
    announce: () => t("entity.regVoid.done", { name }),
    onSuccess: onClose,
  });
  const activeError = error ?? run.error;
  const refusal = end?.delete.refusal ? (fieldRefusal(activeError)(end.delete.refusal) ?? refusalText(end.delete.refusal)) : undefined;
  return (
    <Dialog open title={t("entity.regVoid.title")} onClose={onClose}>
      <div>{t("entity.regVoid.consequence", { name, revisions: Math.max(1, readVersion(r)) })}</div>
      {linked.length > 0 && (
        <div role="status">
          {t("entity.regVoid.inUse", { count: linked.length, names: linked.map((w) => w.current?.name ?? w.id).join(", ") })}
        </div>
      )}
      {end?.can_manage === false && <div role="status">{t("crud.noPermission")}</div>}
      {end?.can_manage !== false && refusal && <div role="status">{refusal}</div>}
      <ChoiceField label={t("entity.void.reason")} required options={REASONS.map((code) => ({ value: code, label: t(`entity.void.reason.${code}`) }))} value={reason} onChange={setReason} />
      <EntityError error={activeError} own={(code) => fieldRefusal(activeError)(code) ?? ownRefusal(code)} />
      <div className="form__actions">
        <Button onClick={onClose}>{t("common.back")}</Button>
        {reason ? (
          <Button variant="danger" disabled={run.isPending} onClick={() => run.mutate(undefined)}>{t("entity.regVoid.confirm")}</Button>
        ) : (
          <DisabledReason layout="inline" reason={t("entity.void.reasonNeeded")} control={(p) => <Button variant="danger" {...p}>{t("entity.regVoid.confirm")}</Button>} />
        )}
      </div>
    </Dialog>
  );
}
