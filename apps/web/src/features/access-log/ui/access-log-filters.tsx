// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { codeText } from "../../../lib/labels";

import { Button, Form } from "../../../ui/button/button";
import { DateInput } from "../../../ui/date/date-input";
import { addDays, inBounds } from "../../../ui/date/days";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import type { AccessLogFilterOptions, AccessLogFilters } from "../api";

// Server label keys resolve `accessLog.action.${code}` and `accessLog.target.${code}` in the catalogs.
export function AccessLogFiltersForm({ value, options, period, onApply }: {
  value: AccessLogFilters;
  options: AccessLogFilterOptions;
  period: { from: string; to: string };
  onApply: (filters: AccessLogFilters) => void;
}) {
  const [draft, setDraft] = useState(() => ({
    ...value,
    actor: options.actors.some(choice => choice.id === value.actor) ? value.actor : undefined,
    action: options.actions.some(choice => choice.id === value.action) ? value.action : undefined,
    target_type: options.target_types.some(choice => choice.id === value.target_type) ? value.target_type : undefined,
  }));
  const [fromInvalid, setFromInvalid] = useState(false);
  const [toInvalid, setToInvalid] = useState(false);
  const from = draft.from ?? "";
  const to = draft.to ?? "";
  const last = addDays(period.to, -1);
  const invalid = fromInvalid || toInvalid || (from && !inBounds(from, period.from, last)) || (to && !inBounds(to, from || period.from, last));
  return <Form className="form" aria-label={t("accessLog.filters")} onReset={event => { event.preventDefault(); onApply({}); }}
    onSubmit={() => { if (!invalid) onApply(draft); }}>
    {([
      ["actor", "accessLog.actor", options.actors],
      ["action", "accessLog.action", options.actions],
      ["target_type", "accessLog.targetType", options.target_types],
    ] as const).map(([name, label, choices]) => <Field key={name} label={t(label)} required={null}>{props =>
      <SelectInput {...props} name={name} value={draft[name] ?? ""} onChange={event => setDraft(previous => ({ ...previous, [name]: event.target.value || undefined }))}>
        <option value="">{t("accessLog.all")}</option>
        {choices.map(choice => <option key={choice.id} value={choice.id}>{"label_key" in choice ? codeText(choice.label_key, choice.id) : choice.label}</option>)}
      </SelectInput>
    }</Field>)}
    <Field label={t("accessLog.from")} required={null}>{props => <DateInput {...props} value={from}
      min={period.from} max={last} onInvalid={setFromInvalid} onChange={value => setDraft(previous => ({ ...previous, from: value || undefined }))} />}</Field>
    <Field label={t("accessLog.to")} required={null}>{props => <DateInput {...props} value={to}
      min={from || period.from} max={last} onInvalid={setToInvalid} onChange={value => setDraft(previous => ({ ...previous, to: value || undefined }))} />}</Field>
    <Button type="reset">{t("accessLog.clearSearch")}</Button>
    <Button type="submit" variant="primary">{t("accessLog.applyFilters")}</Button>
  </Form>;
}
