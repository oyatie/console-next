// SPDX-License-Identifier: LicenseRef-Proprietary
import { checkState } from "../present-verification";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { BusinessRegistration, LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Sheet } from "../../../ui/sheet/sheet";
import { ApiError, checkRegistration, ENTITY_READS, registrationChecksQuery, type CheckEvidence, type CheckAnswer } from "../api";
import { EntityError } from "./entity-error";
import s from "./record.module.css";

const UNAVAILABLE = {
  NOT_CONFIGURED: "nts.unavailable.NOT_CONFIGURED", KEY_EXPIRED: "nts.unavailable.KEY_EXPIRED",
  KEY_REJECTED: "nts.unavailable.KEY_REJECTED", PROVIDER_DOWN: "nts.unavailable.PROVIDER_DOWN",
} as const;

/** One authority-check card, shared by the overview and each recorded certificate. */
export function NtsCheck({ registration: r, entity, canManage = entity.can_manage, onAttach, historical = false }: {
  registration: BusinessRegistration; entity: LegalEntity; canManage?: boolean; onAttach: () => void; historical?: boolean;
}) {
  const title = useId();
  const live = useQuery({ ...registrationChecksQuery(r.id), enabled: !historical });
  const stored = r.nts_check;
  const q = historical ? { ...live, isPending: false, error: null, data: { items: stored ? [stored] : [], latest_status: stored?.kind === "STATUS" ? stored : null, latest_validate: stored?.kind === "VALIDATE" ? stored : null, availability: { available: true, reason: null } } } : live;
  const [reviewing, setReviewing] = useState(false);
  const send = useCommand({
    run: (kind: "STATUS" | "VALIDATE", key: string) => checkRegistration(r.id, kind, key, kind === "VALIDATE" ? { brn: number!, opened_on: r.current!.opened_on!, representative: representative! } : undefined),
    invalidates: ENTITY_READS,
    settle: true,
    onSuccess: () => setReviewing(false),
  });
  const number = r.brn?.value;
  const opening = r.current?.opened_on?.replaceAll("-", "");
  const representative = entity.current?.representatives?.[0];
  const ended = Boolean(r.voided);
  const allowed = !historical && canManage && number && !ended;
  const validateReady = Boolean(opening && representative);
  const error = send.error instanceof ApiError ? send.error : undefined;
  const reportedReason = error?.code === "registration_check_unavailable" ? error.details.reason : null;
  const failedReason = typeof reportedReason === "string" && Object.hasOwn(UNAVAILABLE, reportedReason) ? reportedReason as keyof typeof UNAVAILABLE : null;
  return (
    <section className="card" aria-labelledby={title} id={`nts-${r.id}`}>
      <div className={s.cardHead}><h2 id={title} className={s.cardTitle}>{t("nts.title")}</h2></div>
      <div className={s.cardBody}>
        <QueryState q={q}>
          {(history) => {
            const checks = [history.latest_status, history.latest_validate].filter((check): check is CheckEvidence => Boolean(check));
            const latest = checks.reduce<CheckEvidence | undefined>((last, check) => !last || check.checked_at > last.checked_at ? check : last, undefined);
            const available = history.availability.available && error?.code !== "registration_check_unavailable";
            const reason = failedReason ?? history.availability.reason ?? "PROVIDER_DOWN";
            const badge = checkState(latest, available);
            return <>
              <Chip tone={badge.tone}>{badge.label}</Chip>
              {latest && <>
                <KeyValue items={[{ key: "checked", label: t("nts.checkedAt"), value: `${fmtDateTime(latest.checked_at)} · ${t(`nts.kind.${latest.kind}`)}` }]} />
                <NtsResult check={latest} />
              </>}
              {!available && <>
                <p>{t(UNAVAILABLE[reason])}</p>
                <p>{t("nts.fallback")}</p>
                {canManage && <Button onClick={onAttach}>{t("nts.attach")}</Button>}
              </>}
              {!number ? <p>{t("nts.action.noNumber")}</p> : ended ? <p>{t("nts.action.ended")}</p> : !canManage && !historical ? <p>{t("nts.action.noPermission")}</p> : null}
              {available && allowed && <div className="row wrap">
                <Button aria-disabled={send.isPending || undefined} onClick={() => !send.isPending && send.mutate("STATUS")}>{t("nts.action.status")}</Button>
                {validateReady
                  ? <Button aria-disabled={send.isPending || undefined} onClick={() => !send.isPending && setReviewing(true)}>{t("nts.action.validate")}</Button>
                  : <p>{t("nts.action.incomplete")}</p>}
              </div>}
              <EntityError error={send.error} own={(code) => code === "registration_check_rate_limited" ? t("nts.rateLimited", { seconds: Math.ceil((error?.retryAfterMs ?? 0) / 1000) }) : undefined} />
              {available && allowed && validateReady && <Sheet
                open={reviewing}
                title={t("nts.validate.title")}
                onClose={() => setReviewing(false)}
                pending={send.isPending}
                consequence={t("nts.validate.consequence")}
                notice={<EntityError error={send.error} />}
                actions={<>
                  <Button onClick={() => setReviewing(false)}>{t("entityRecord.cancel")}</Button>
                  <Button variant="primary" onClick={() => !send.isPending && send.mutate("VALIDATE")}>{t("nts.validate.send")}</Button>
                </>}
              >
                <p>{t("nts.validate.purpose")}</p>
                <KeyValue items={[
                  { key: "number", label: t("nts.validate.brn"), value: number },
                  { key: "opening", label: t("nts.validate.openedOn"), value: opening },
                  { key: "representative", label: t("nts.validate.representative"), value: representative },
                ]} />
              </Sheet>}
            </>;
          }}
        </QueryState>
      </div>
    </section>
  );
}

export function NtsResult({ check }: { check: CheckAnswer & Partial<Pick<CheckEvidence, "reflection_pending" | "recorded_status_mismatch" | "inbox_item_id">> }) {
  const sent = { b_no: t("nts.validate.brn"), start_dt: t("nts.validate.openedOn"), p_nm: t("nts.validate.representative") };
  return <div role="status">
    <p>{check.valid === "02" ? t("nts.result.invalid") : check.not_registered ? t("nts.result.notRegistered") : check.status_code === "01" ? t("nts.result.continuing") : check.status_code === "02" ? t("nts.result.suspended") : check.status_code === "03" ? t("nts.result.closed", { date: fmtDate(check.end_dt?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")) }) : t("nts.result.noResult")}</p>
    {check.valid === "02" && <>
      <p>{t("nts.result.invalidWhy")}</p>
      <ul>{check.fields_sent.map((field) => Object.hasOwn(sent, field) ? <li key={field}>{sent[field as keyof typeof sent]}</li> : null)}</ul>
    </>}
    {check.reflection_pending && <p>{t("nts.reflectionPending")}</p>}
    {check.recorded_status_mismatch && <p>{t("nts.mismatch")} {check.inbox_item_id && <Link to="/" hash={`nts-${check.inbox_item_id}`}>{t("nts.inbox")}</Link>}</p>}
  </div>;
}
