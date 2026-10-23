// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { BusinessRegistration } from "@console/api/pending";
import { t } from "@console/i18n";
import { freshOnOpen } from "../../../lib/query";
import { useCommand } from "../../../lib/react/command";
import { SupportReference } from "../../../lib/react/support-reference";
import { ownRefusal, refusalText } from "../../../reference/crud/present";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { reasonCodesQuery, reasonOptions } from "../../../lib/reason-codes";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ApiError, ENTITY_READS, registrationEndQuery, voidRegistration } from "../api";
import { fieldRefusal } from "../present";
import { EntityError } from "./entity-error";
import s from "./entity.module.css";

/** A mistaken certificate's setup void: the server owns its permission, blockers and cascade preview. */
export function VoidRegistration({ r, entityId, onClose }: { r: BusinessRegistration; entityId: string; onClose: () => void }) {
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
  const reasons = useQuery(reasonCodesQuery("business_registration_end"));
  const choices = reasonOptions("business_registration_end", reasons.data?.items).filter((o) => !o.requiresNote);
  const refusal = end?.delete.refusal ? (fieldRefusal(run.error)(end.delete.refusal) ?? refusalText(end.delete.refusal)) : undefined;
  const previewBlock = preview.isError ? undefined
    : !end || preview.fetchStatus !== "idle" ? t("entity.regVoid.previewLoading")
    : !end.can_manage ? t("crud.noPermission")
    : end.phase !== "SETUP" ? t("entity.regVoid.operatingWhy")
    : linked.length > 0 ? t("entity.regVoid.inUse", { count: linked.length })
    : !end.delete.allowed || end.delete.refusal ? refusal ?? t("entity.regVoid.previewFailed")
    : undefined;
  const blocked = preview.isError ? t("entity.regVoid.previewFailed") : previewBlock
    ?? (!reasons.isSuccess || !choices.some((o) => o.value === reason) ? t("entity.void.reasonNeeded") : undefined);
  return (
    <Dialog open title={t("entity.regVoid.title")} dismissable={!run.isPending} onClose={() => { if (!run.isPending) onClose(); }}>
      <div className={s.voidPreview}>
        {!preview.isError && end && <div>{t("entity.regVoid.consequence", { name, revisions: end.revisions })}</div>}
        {!preview.isError && linked.length > 0 && <ul>{linked.map((w) => <li key={w.id}><Link to="/org/entities/$id" params={{ id: entityId }} search={{ wp: w.id }} onClick={onClose}>{w.name}</Link></li>)}</ul>}
        {preview.isError && <EmptyState alert title={t("entity.regVoid.previewFailed")} reason={run.isIdle ? t("entity.regVoid.notSent") : null} actions={<Button onClick={() => void preview.refetch()}>{t("entity.regVoid.previewRetry")}</Button>} meta={<SupportReference reference={preview.error instanceof ApiError ? preview.error.supportRef : undefined} at={preview.error instanceof ApiError ? preview.error.supportRefAt : undefined} />} />}
        <EntityError error={run.error} own={(code) => fieldRefusal(run.error)(code) ?? ownRefusal(code)} />
      </div>
      <fieldset className="form__group" disabled={preview.isError || !!previewBlock || run.isPending}>
        <ReasonCodeField domain="business_registration_end" noteless label={t("entity.void.reason")} value={reason} onChange={setReason} />
      </fieldset>
      <div className={s.voidActions}>
        <Button disabled={run.isPending} onClick={onClose}>{t("common.back")}</Button>
        {preview.isError ? (
          <Button variant="danger" disabled>{t("entity.regVoid.confirm")}</Button>
        ) : !blocked ? (
          <Button variant="danger" disabled={run.isPending} onClick={() => run.mutate(undefined)}>{t("entity.regVoid.confirm")}</Button>
        ) : (
          <DisabledReason reason={blocked} control={(p) => <Button variant="danger" {...p}>{t("entity.regVoid.confirm")}</Button>} />
        )}
      </div>
    </Dialog>
  );
}
