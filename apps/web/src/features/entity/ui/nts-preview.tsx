// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { FORMATS } from "../../../lib/pure/formats";
import { useCommand } from "../../../lib/react/command";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button, Check } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Sheet } from "../../../ui/sheet/sheet";
import { ApiError, previewRegistrationCheck, registrationCheckAvailabilityQuery, type CheckPreview } from "../api";
import { EntityError } from "./entity-error";
import { Chip } from "../../../ui/chip";
import { checkState } from "../present-verification";
import { NtsResult } from "./nts-check";
import type { CreateState } from "./use-create";
import s from "./entity-create.module.css";

/** Optional authority check before saving; an answer is adopted only with the values that produced it. */
export function NtsPreview({ c }: { c: CreateState }) {
  const title = useId();
  const q = useQuery(registrationCheckAvailabilityQuery);
  const [reviewing, setReviewing] = useState(false);
  const values = { brn: c.draft.brn, opened_on: c.draft.openedOn, representative: (c.draft.representatives[0] ?? "").trim() };
  const ready = values.brn.length === FORMATS.bizRegNo.max && values.opened_on !== "";
  const validateReady = ready && values.representative !== "";
  const send = useCommand({
    run: async (kind: "STATUS" | "VALIDATE", key: string): Promise<CheckPreview> => ({
      answer: await previewRegistrationCheck(key, { kind, ...values }), command_id: key, values, acknowledged: false,
    }),
    invalidates: ["/api/v1/registration-checks"],
    onSuccess: (result) => { c.setPreview(result); setReviewing(false); },
  });
  const stale = send.data && (send.data.values.brn !== values.brn || send.data.values.opened_on !== values.opened_on || send.data.values.representative !== values.representative);
  const preview = c.preview;
  const warn = preview && (preview.answer.reported_status === "SUSPENDED" || preview.answer.reported_status === "CLOSED");
  const error = send.error instanceof ApiError ? send.error : undefined;
  const request = (kind: "STATUS" | "VALIDATE") => {
    if (send.isPending || !ready || (kind === "VALIDATE" && !validateReady)) return;
    c.setPreview(null);
    send.mutate(kind);
  };
  return <section className="card" aria-labelledby={title}>
    <div className={s.cardHead}><h3 id={title} className={s.cardTitle}>{t("nts.preview.title")}</h3></div>
    <div className={s.cardBody}>
      <QueryState q={q}>
        {(availability) => {
          const available = availability.available && error?.code !== "registration_check_unavailable";
          const reported = error?.details.reason;
          const reason = reported === "NOT_CONFIGURED" || reported === "KEY_EXPIRED" || reported === "KEY_REJECTED" || reported === "PROVIDER_DOWN" ? reported : availability.reason ?? "PROVIDER_DOWN";
          return <>
            {!available && <>
              <p>{t(`nts.unavailable.${reason}`)}</p>
              <p>{t("nts.fallback")}</p>
              <Button onClick={() => document.getElementById("original-title")?.closest("section")?.querySelector<HTMLButtonElement>("button")?.focus()}>{t("nts.attach")}</Button>
            </>}
            {available && ready && <>
              <KeyValue items={[{ key: "number", label: t("nts.validate.brn"), value: values.brn }]} />
              <div className="row wrap">
                <Button aria-disabled={send.isPending || undefined} onClick={() => request("STATUS")}>{t("nts.preview.status")}</Button>
                {validateReady ? <Button aria-disabled={send.isPending || undefined} onClick={() => !send.isPending && setReviewing(true)}>{t("nts.action.validate")}</Button> : <p>{t("nts.action.incomplete")}</p>}
              </div>
            </>}
            {available && !ready && <p>{t(values.brn.length !== FORMATS.bizRegNo.max ? "nts.action.noNumber" : "nts.action.incomplete")}</p>}
            {preview ? <>
              <Chip tone={checkState(preview.answer).tone}>{checkState(preview.answer).label}</Chip>
              <NtsResult check={preview.answer} />
              {warn && <Banner tone="warn" live="polite">
                <p>{t("nts.preview.warning")}</p>
                {preview.answer.reported_status === "SUSPENDED" && <DateField
                  label={t("nts.preview.statusSince")} required value={preview.status_since ?? ""}
                  today={c.today} min={c.draft.openedOn} max={c.today}
                  onChange={(date) => c.setPreview({ ...preview, status_since: date, acknowledged: false })}
                  onInvalid={(invalid) => invalid && c.setPreview({ ...preview, status_since: undefined, acknowledged: false })}
                />}
                <Check checked={preview.acknowledged} onChange={(acknowledged) => c.setPreview({ ...preview, acknowledged })}>{t("nts.preview.ack")}</Check>
              </Banner>}
              <Button variant="ghost" onClick={() => c.setPreview(null)}>{t("nts.preview.clear")}</Button>
            </> : <p>{t(stale ? "nts.preview.stale" : "nts.preview.skipped")}</p>}
            <EntityError error={send.error} own={(code) => code === "registration_check_rate_limited" ? t("nts.rateLimited", { seconds: Math.ceil((error?.retryAfterMs ?? 0) / 1000) }) : undefined} />
            {available && validateReady && <Sheet open={reviewing} title={t("nts.validate.title")} pending={send.isPending} onClose={() => setReviewing(false)}
              consequence={t("nts.validate.consequence")} notice={<EntityError error={send.error} />}
              actions={<><Button onClick={() => setReviewing(false)}>{t("entityRecord.cancel")}</Button><Button variant="primary" onClick={() => request("VALIDATE")}>{t("nts.validate.send")}</Button></>}
            >
              <p>{t("nts.validate.purpose")}</p>
              <KeyValue items={[
                { key: "number", label: t("nts.validate.brn"), value: values.brn },
                { key: "opening", label: t("nts.validate.openedOn"), value: values.opened_on.replaceAll("-", "") },
                { key: "representative", label: t("nts.validate.representative"), value: values.representative },
              ]} />
            </Sheet>}
          </>;
        }}
      </QueryState>
    </div>
  </section>;
}
