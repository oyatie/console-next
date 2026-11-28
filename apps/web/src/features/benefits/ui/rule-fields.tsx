// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { codeText } from "../../../lib/code-text";
import { Form } from "../../../ui/button/button";
import { Button } from "../../../ui/button/button-base";
import { Field, FieldSet, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { SelectInput } from "../../../ui/field/select-input";
import type { Change, Condition, Item, Tier } from "../api";
import { BenefitSelect, BenefitText } from "./benefit-fields";
import s from "./benefits.module.css";

const kinds = ["ORG", "BRANCH", "SITE", "TEAM", "ROLE", "POSITION", "TENURE", "AGE", "GENDER", "EMPLOYMENT_TYPE", "CONTRACT", "COST_CENTER", "CUSTOM"];
const operators = ["eq", "in", "not_in", "gte", "lte", "range", "exists", "custom_policy"];
const periods = ["MONTH", "QUARTER", "YEAR", "EVENT", "TENURE_MILESTONE"];
const options = (values: string[]) => values.map(value => ({ value, label: codeText(`benefits.code.${value}`, value) }));

type RuleKind = "conditions" | "tiers";
type Draft = { id: string; type: string; key: string; label: string; operator: string; policy: string; amount: string; period: string; data: string; order: string };
function row(item: Tier | Condition): Draft {
  const tier = "tier_basis" in item;
  return { id: item.id ?? crypto.randomUUID(), type: tier ? item.tier_basis : item.condition_kind,
    key: tier ? item.tier_key : item.condition_key, label: tier ? item.value_label : item.display_label,
    operator: tier ? "" : item.operator, policy: tier ? "" : item.cedar_policy_ref ?? "",
    amount: tier && item.amount_won != null ? String(item.amount_won) : "", period: tier ? item.limit_period ?? "" : "",
    data: JSON.stringify(tier ? item.criteria : item.condition_value, null, 2), order: String(item.display_order) };
}
function blank(order: number): Draft {
  return { id: crypto.randomUUID(), type: "", key: "", label: "", operator: "", policy: "", amount: "", period: "", data: "{}", order: String(order) };
}
function object(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
function valid(d: Draft, kind: RuleKind) {
  return !!(d.type.trim() && d.key.trim() && d.label.trim() && object(d.data) && d.order.trim() && Number.isSafeInteger(Number(d.order))
    && (kind === "conditions" ? d.operator : !d.amount || Number.isSafeInteger(Number(d.amount)) && Number(d.amount) >= 0));
}
export function RuleFields({ kind, item, busy, submit }: { kind: RuleKind; item: Item; busy: boolean; submit: (change: Change) => void }) {
  const [rows, setRows] = useState(() => item[kind].map(row));
  const [changed, change] = useState(false);
  const write = (next: Draft[]) => { setRows(next); change(true); };
  const patch = (id: string, values: Partial<Draft>) => write(rows.map(r => r.id === id ? { ...r, ...values } : r));
  const allValid = rows.every(r => valid(r, kind));
  function save() {
    if (!changed || !allValid || busy) return;
    const expectedUpdatedAt = item.updated_at;
    if (kind === "tiers") submit({ kind, id: item.id, body: { expectedUpdatedAt, tiers: rows.map(r => ({
      tier_basis: r.type.trim(), tier_key: r.key.trim(), value_label: r.label.trim(), criteria: object(r.data)!,
      amount_won: r.amount ? Number(r.amount) : null, limit_period: r.period || null, display_order: Number(r.order),
    })) } });
    else submit({ kind, id: item.id, body: { expectedUpdatedAt, conditions: rows.map(r => ({
      condition_kind: r.type, operator: r.operator, condition_key: r.key.trim(), display_label: r.label.trim(),
      condition_value: object(r.data)!, cedar_policy_ref: r.policy.trim() || null, display_order: Number(r.order),
    })) } });
  }
  return <Form className={s.form} onSubmit={save}>
    {rows.map((r, i) => <FieldSet key={r.id} label={t(kind === "tiers" ? "benefits.tierN" : "benefits.conditionN", { n: i + 1 })} required={null}>
      {kind === "tiers" ? <BenefitText label="benefits.basis" required value={r.type} set={type => patch(r.id, { type })} />
        : <><BenefitSelect label="benefits.kind" value={r.type} options={options(kinds)} set={type => patch(r.id, { type })} />
          <BenefitSelect label="benefits.operator" value={r.operator} options={options(operators)} set={operator => patch(r.id, { operator })} /></>}
      <BenefitText label="benefits.key" required value={r.key} set={key => patch(r.id, { key })} />
      <BenefitText label="benefits.label" required value={r.label} set={label => patch(r.id, { label })} />
      {kind === "tiers" ? <>
        <Field label={t("benefits.amount")} required={false}>{props => <TextInput {...props} type="number" min={0} step={1} value={r.amount} onChange={e => patch(r.id, { amount: e.target.value })} />}</Field>
        <Field label={t("benefits.period")} required={false}>{props => <SelectInput {...props} value={r.period} onChange={e => patch(r.id, { period: e.target.value })}>
          <option value="">{t("benefits.noPeriod")}</option>{options(periods).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </SelectInput>}</Field>
      </> : <BenefitText label="benefits.policy" value={r.policy} set={policy => patch(r.id, { policy })} />}
      <Field label={t("benefits.order")} required>{props => <TextInput {...props} type="number" step={1} value={r.order} onChange={e => patch(r.id, { order: e.target.value })} />}</Field>
      <Field label={t(kind === "tiers" ? "benefits.criteria" : "benefits.value")} required error={!object(r.data) ? t("benefits.objectError") : undefined}>
        {props => <TextArea {...props} rows={3} value={r.data} onChange={e => patch(r.id, { data: e.target.value })} />}
      </Field>
      <Button onClick={() => write(rows.filter(v => v.id !== r.id))}>{t("benefits.remove")}</Button>
    </FieldSet>)}
    <div className={s.actions}>
      <Button onClick={() => write([...rows, blank(rows.length)])}>{t(kind === "tiers" ? "benefits.addTier" : "benefits.addCondition")}</Button>
      <Button type="submit" disabled={!changed || !allValid || busy}>{t("benefits.save")}</Button>
    </div>
  </Form>;
}
