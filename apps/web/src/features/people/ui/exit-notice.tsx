// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { Chip } from "../../../ui/chip";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { ProtectedPeriods } from "./exit-protection";
import { t } from "@console/i18n";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { DateChips } from "../../../ui/date/date-chips";
import { addDays } from "../../../ui/date/days";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { noticeMissing, protectedLines, type NoticeDraft } from "../domain/exits";
import s from "./exit.module.css";

const METHODS = ["IN_PERSON_SIGNED", "CERTIFIED_MAIL", "ELECTRONIC"] as const;
/** The delivery methods are the contract's closed enum; the server validates and stores the evidence. */
export function ExitGuardFields({ c, reason, onReason, involuntary, noticeRequired, value, onChange, tried }: {
  c: components["schemas"]["EmployeeExitCase"];
  reason: string | null;
  onReason: (reason: string) => void;
  involuntary: boolean;
  noticeRequired: boolean;
  value: NoticeDraft;
  onChange: (value: NoticeDraft) => void;
  tried: boolean;
}) {
  const exitDate = c.effective_exit_date;
  const missing = noticeMissing(value, exitDate);
  const error = (key: keyof NoticeDraft) => tried && missing.includes(key) ? t("exit.notice.required") : undefined;
  return <>
    {!c.exit_reason_code && <ReasonCodeField domain="exit_reason" look="chips" required label={t("exit.field.reason")} value={reason} onChange={onReason} error={tried && !reason ? t("exit.error.exit_reason_required") : undefined} />}
    {involuntary && <Chip tone="warn">{t("exit.class.involuntary")}</Chip>}
    {involuntary && <ProtectedPeriods periods={protectedLines(c)} />}
    {noticeRequired && <fieldset className={s.group}>
    <legend className={s.groupTitle}>{t("exit.notice.title")}</legend>
    <Field label={t("exit.notice.reason_text")} required error={error("reason_text")}>
      {(p) => <TextArea {...p} maxLength={1000} value={value.reason_text} onChange={(e) => onChange({ ...value, reason_text: e.target.value })} />}
    </Field>
    <DateChips presets={[]} label={t("exit.notice.served_on")} required value={value.served_on} onChange={(served_on) => onChange({ ...value, served_on })} max={addDays(exitDate, 1)} showErrors={tried} error={error("served_on")} />
    <ChoiceField label={t("exit.notice.method")} required value={value.method || null} options={METHODS.map((method) => ({ value: method, label: t(`exit.notice.method.${method}`) }))} onChange={(method) => onChange({ ...value, method })} error={error("method")} />
    <Field label={t("exit.notice.evidence_ref")} required error={error("evidence_ref")}>
      {(p) => <TextInput {...p} maxLength={1000} value={value.evidence_ref} onChange={(e) => onChange({ ...value, evidence_ref: e.target.value })} />}
    </Field>
  </fieldset>}
  </>;
}
