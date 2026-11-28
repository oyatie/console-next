// SPDX-License-Identifier: LicenseRef-Proprietary
import { t, type MessageId } from "@console/i18n";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";

export function BenefitText({ label, value, set, required = false, maxLength }: { label: MessageId; value: string; set: (value: string) => void; required?: boolean; maxLength?: number }) {
  return <Field label={t(label)} required={required}>{props => <TextInput {...props} value={value} maxLength={maxLength} onChange={event => set(event.target.value)} />}</Field>;
}

export function BenefitSelect({ label, value, set, options }: { label: MessageId; value: string; set: (v: string) => void; options: readonly { value: string; label: string }[] }) {
  return <Field label={t(label)} required>{props => <SelectInput {...props} value={value} onChange={e => set(e.target.value)}>
    <option value="">{t("benefits.choose")}</option>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </SelectInput>}</Field>;
}
