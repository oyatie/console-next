// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BusinessRegistration } from "@console/api/pending";
import { t } from "@console/i18n";
import { freshOnOpen } from "../../../lib/query";
import { useCommand } from "../../../lib/react/command";
import { ownRefusal, refusalText } from "../../../reference/crud/present";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ENTITY_READS, registrationEndQuery, voidRegistration } from "../api";
import { fieldRefusal } from "../present";
import { EntityError } from "./entity-error";
import s from "./entity.module.css";

const REASONS = ["DUPLICATE", "TEST_ENTRY", "WRONG_DOCUMENT"] as const;

/** A mistaken certificate's setup void: the server owns its permission, blockers and cascade preview. */
export function VoidRegistration({ r, onClose }: { r: BusinessRegistration; onClose: () => void }) {
  const name = r.brn?.display ?? r.current?.trade_name ?? t("entityRecord.cert.title");
  const preview = freshOnOpen(useQuery({ ...registrationEndQuery(r.id), retry: false, refetchOnMount: "always" }));
  const end = preview.data;
  const linked = end?.linked_workplaces ?? [];
  const [reason, setReason] = useState<string | null>(null);
  const run = useCommand({
    run: (_: undefined, key: string) => voidRegistration(key, r.id, reason!),
    invalidates: ENTITY_READS,
    announce: () => t("entity.regVoid.done", { name }),
    onSuccess: onClose,
  });
  const activeError = run.error ?? preview.error;
  const refusal = end?.delete.refusal ? (fieldRefusal(activeError)(end.delete.refusal) ?? refusalText(end.delete.refusal)) : undefined;
  const blocked = preview.isError ? t("entity.regVoid.previewFailed")
    : !end || preview.fetchStatus !== "idle" ? t("entity.regVoid.previewLoading")
    : !end.can_manage ? t("crud.noPermission")
    : end.phase !== "SETUP" ? t("entity.regVoid.operatingWhy")
    : linked.length > 0 ? t("entity.refused.record_in_use")
    : !end.delete.allowed || end.delete.refusal ? refusal ?? t("entity.regVoid.previewFailed")
    : !reason ? t("entity.void.reasonNeeded") : undefined;
  return (
    <Dialog open title={t("entity.regVoid.title")} onClose={onClose}>
      <div className={s.voidPreview}>
        {end && <div>{t("entity.regVoid.consequence", { name, revisions: end.revisions })}</div>}
        {preview.fetchStatus !== "idle" && <div role="status">{t("entity.regVoid.previewLoading")}</div>}
        {preview.isError && <Button onClick={() => void preview.refetch()}>{t("entity.regVoid.previewRetry")}</Button>}
        {linked.length > 0 && (
          <div role="status">
            {t("entity.regVoid.inUse", { count: linked.length, names: linked.map((w) => w.name).join(", ") })}
          </div>
        )}
        {end?.can_manage === false && <div role="status">{t("crud.noPermission")}</div>}
        {end?.can_manage !== false && refusal && <div role="status">{refusal}</div>}
        <EntityError error={activeError} own={(code) => fieldRefusal(activeError)(code) ?? ownRefusal(code)} />
      </div>
      <ChoiceField label={t("entity.void.reason")} required options={REASONS.map((code) => ({ value: code, label: t(`entity.void.reason.${code}`) }))} value={reason} onChange={setReason} />
      <div className={s.voidActions}>
        <Button onClick={onClose}>{t("common.back")}</Button>
        {!blocked ? (
          <Button variant="danger" disabled={run.isPending} onClick={() => run.mutate(undefined)}>{t("entity.regVoid.confirm")}</Button>
        ) : (
          <DisabledReason reason={blocked} control={(p) => <Button variant="danger" {...p}>{t("entity.regVoid.confirm")}</Button>} />
        )}
      </div>
    </Dialog>
  );
}
