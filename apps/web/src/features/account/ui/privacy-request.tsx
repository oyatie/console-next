// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import type { PrivacyFiling, PrivacyFilingOptions, PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { useDraft } from "../../../lib/react/use-draft";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Checks } from "../../../ui/choice/checks";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { filePrivacyRequest, privacyFilingOptionsQuery, privacyReceipt } from "../api";
import s from "./account.module.css";

export function PrivacyRequest({ onFiled }: { onFiled: (receipt: PrivacyRightsReceipt) => void }) {
  const q = useQuery({ ...privacyFilingOptionsQuery, retry: false });
  return <Card title={t("account.privacy.file")}>
    <QueryState q={q} layout="record">{options => <PrivacyRequestForm options={options} onFiled={onFiled} />}</QueryState>
  </Card>;
}

export function PrivacyRequestForm({ options, onFiled }: { options: PrivacyFilingOptions; onFiled: (receipt: PrivacyRightsReceipt) => void }) {
  const draft = useDraft({ route: "/account/privacy", record: "new", form: "privacy-request",
    initial: { controller: "", kinds: "", detail: "" },
    text: v => `${t("account.privacy.title")}\n${v.controller}\n${v.kinds}\n${v.detail}`,
  });
  const { controller, detail } = draft.value;
  const kinds = draft.value.kinds ? draft.value.kinds.split(",") : [];
  const chosen = options.kinds.filter(kind => kinds.includes(kind.code));
  const valid = options.controllers.some(item => item.code === controller) && kinds.length > 0
    && chosen.length === kinds.length && Array.from(detail).length <= options.detail_max_length;
  const command = useCommand({
    run: (input: PrivacyFiling, key) => filePrivacyRequest(options.subject_user_id, input, key),
    invalidates: ["/api/v1/privacy/rights-requests"],
    onSuccess: receipt => { draft.discard(); onFiled(privacyReceipt(receipt, options.as_of)); },
  });
  const dates = chosen.flatMap(kind => kind.due_on ? [kind.due_on] : []).sort();
  return <div className={s.form}>
    {draft.problem || draft.restored ? <output>{t(draft.problem ? "draft.unavailable" : "draft.restored")}</output> : null}
    <ChoiceField label={t("account.privacy.information")} required options={options.controllers.map(item => ({ value: item.code, label: item.label, description: item.description, disabled: command.isPending ? t("common.loading") : undefined }))}
      value={controller || null} onChange={value => { draft.set({ ...draft.value, controller: value }); }} />
    <Checks label={t("account.privacy.kinds")} items={options.kinds.map(kind => ({ id: kind.code, label: `${kind.label} · ${kind.description}` }))}
      value={kinds} isDisabled={command.isPending} onChange={value => { draft.set({ ...draft.value, kinds: value.join(",") }); }} />
    <Field label={t("account.privacy.detail")} required={false} hint={t("account.privacy.detailHint")}>
      {control => <TextArea {...control} maxLength={options.detail_max_length} value={detail} disabled={command.isPending}
        onChange={event => { draft.set({ ...draft.value, detail: event.target.value }); }} />}
    </Field>
    <div>{t("account.privacy.reply")}{options.reply_email_masked && <> · <bdi>{options.reply_email_masked}</bdi></>}</div>
    {dates.length > 0 && <div>{t("account.privacy.deadline", { date: fmtDate(dates[0]) })}</div>}
    {chosen.some(kind => kind.without_delay) && <div>{t("account.privacy.withoutDelay")}</div>}
    {chosen.some(kind => !kind.due_on && !kind.without_delay) && <div>{t("account.privacy.noClock")}</div>}
    <div>{t("account.privacy.identity")}</div>
    <PasskeyError error={command.error} />
    <Button variant="primary" disabled={!valid || command.isPending} onClick={() => {
      command.mutate({ controller: controller as PrivacyFiling["controller"], kinds: kinds as PrivacyFiling["kinds"], detail });
    }}>{t("account.privacy.submit")}</Button>
  </div>;
}
