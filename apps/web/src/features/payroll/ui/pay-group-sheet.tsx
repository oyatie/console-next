// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Composer } from "../../../ui/composer/composer";
import { Field, FieldSet, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { Checks } from "../../../ui/choice/checks";
import { createPayGroup, type CreatePayGroup } from "../api";
import { payGroupInput, type PayGroupDraft } from "../domain/pay-group-input";

type Option<T> = { value: T; label: string };
const payMonths = [0, 1] as const satisfies readonly CreatePayGroup["pay_date_rule"]["month_offset"][];
const periodMonths = [-1, 0] as const satisfies readonly CreatePayGroup["base_period"]["month_offset"][];
const businessDays = ["PREVIOUS", "NEXT"] as const satisfies readonly CreatePayGroup["pay_date_rule"]["non_business_day"][];
const prorations = ["CALENDAR_DAYS", "SCHEDULED_WORKDAYS"] as const satisfies readonly CreatePayGroup["proration"][];
const channels = ["ATTESTATION_ONLY", "FILE_GENERIC"] as const satisfies readonly CreatePayGroup["channel"][];
const payBases = ["MONTHLY", "HOURLY"] as const satisfies readonly CreatePayGroup["pay_basis_allowed"][number][];
const days = (max: number) => Array.from({ length: max }, (_, n) => ({ value: n + 1, label: t("payroll.rule.day", { day: n + 1 }) }));

function Choice<T extends string | number | boolean>({ label, value, options, onChange }: { label: string; value: T | undefined; options: readonly Option<T>[]; onChange: (value: T) => void }) {
  return <Field label={label} required>{control => <SelectInput {...control} value={value === undefined ? "" : String(value)} onChange={event => {
    const option = options.find(row => String(row.value) === event.target.value);
    if (option) onChange(option.value);
  }}><option value="" disabled>{t("payroll.setup.choose")}</option>{options.map(row => <option key={String(row.value)} value={String(row.value)}>{row.label}</option>)}</SelectInput>}</Field>;
}

export function PayGroupSheet({ entities, onClose, onSaved }: { entities: readonly { id: string; name: string | null }[]; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<PayGroupDraft>({ pay_date_rule: {}, base_period: {}, variable_period: {} });
  const [attempted, setAttempted] = useState(false);
  const input = payGroupInput(draft);
  const change = <K extends keyof PayGroupDraft>(key: K, value: PayGroupDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const save = useCommand({ run: createPayGroup, invalidates: ["/api/v1/payroll/pay-groups"], settle: true,
    announce: group => t("payroll.setup.saved", { name: group.name }), onSuccess: onSaved });
  const period = (key: "base_period" | "variable_period") => <FieldSet label={t(key === "base_period" ? "payroll.basePeriod" : "payroll.variablePeriod")} required>
    <Choice label={t("payroll.setup.month")} value={draft[key].month_offset} options={periodMonths.map(value => ({ value, label: t(`payroll.rule.periodMonth.${value}`) }))} onChange={month_offset => change(key, { ...draft[key], month_offset })} />
    <Choice<CreatePayGroup["base_period"]["start_day"]> label={t("payroll.setup.startDay")} value={draft[key].start_day} options={[{ value: "FIRST", label: t("payroll.rule.day", { day: 1 }) }, ...days(28).slice(1)]} onChange={start_day => change(key, { ...draft[key], start_day })} />
  </FieldSet>;
  return <Composer title={t("payroll.setup.add")} subtitle={t("payroll.setup.explicit")} onClose={onClose} pending={save.isPending} action={{ kind: "payGroup", mode: "save" }}
    consequence={input ? t("payroll.setup.consequence", { entity: entities.find(row => row.id === input.legal_entity_id)?.name ?? t("payroll.entityUnnamed"), name: input.name }) : t("payroll.setup.explicit")}
    notice={<CommandError error={save.error} />}
    onSubmit={() => { setAttempted(true); if (!input) return false; save.mutate(input); }}>
      <Choice label={t("payroll.entity")} value={draft.legal_entity_id} options={entities.map(row => ({ value: row.id, label: row.name ?? t("payroll.entityUnnamed") }))} onChange={value => change("legal_entity_id", value)} />
      <Field label={t("payroll.setup.name")} required>{control => <TextInput {...control} value={draft.name ?? ""} maxLength={40} onChange={event => change("name", event.target.value)} />}</Field>
      <FieldSet label={t("payroll.payDateRule")} required>
        <Choice label={t("payroll.setup.month")} value={draft.pay_date_rule.month_offset} options={payMonths.map(value => ({ value, label: t(`payroll.rule.payMonth.${value}`) }))} onChange={month_offset => change("pay_date_rule", { ...draft.pay_date_rule, month_offset })} />
        <Choice<CreatePayGroup["pay_date_rule"]["day"]> label={t("payroll.setup.day")} value={draft.pay_date_rule.day} options={[...days(31), { value: "LAST_DAY", label: t("payroll.rule.lastDay") }]} onChange={day => change("pay_date_rule", { ...draft.pay_date_rule, day })} />
        <Choice label={t("payroll.setup.holiday")} value={draft.pay_date_rule.non_business_day} options={businessDays.map(value => ({ value, label: t(`payroll.rule.${value}`) }))} onChange={non_business_day => change("pay_date_rule", { ...draft.pay_date_rule, non_business_day })} />
      </FieldSet>
      {period("base_period")}{period("variable_period")}
      <Choice label={t("payroll.proration")} value={draft.proration} options={prorations.map(value => ({ value, label: t(`payroll.rule.${value}`) }))} onChange={value => change("proration", value)} />
      <Choice label={t("payroll.channel")} value={draft.channel} options={channels.map(value => ({ value, label: t(`payroll.rule.${value}`) }))} onChange={value => change("channel", value)} />
      <Choice label={t("payroll.sensitive")} value={draft.sensitive} options={[true, false].map(value => ({ value, label: t(value ? "payroll.rule.sensitive.true" : "payroll.rule.sensitive.false") }))} onChange={value => change("sensitive", value)} />
      <p className="muted">{t("payroll.setup.sensitiveHint")}</p>
      <Checks label={t("payroll.payBasisAllowed")} items={payBases.map(id => ({ id, label: t(`payroll.rule.${id}`) }))} value={draft.pay_basis_allowed ?? []} onChange={values => change("pay_basis_allowed", payBases.filter(value => values.includes(value)))} error={attempted && !draft.pay_basis_allowed?.length ? t("payroll.setup.basisRequired") : undefined} />
      {attempted && !input && <p role="alert">{t("payroll.setup.explicit")}</p>}
  </Composer>;
}
