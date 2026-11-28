// SPDX-License-Identifier: LicenseRef-Proprietary
import { t, type MessageId } from "@console/i18n";
import { fmtDate, fmtKrw, fmtNumber } from "@console/i18n/format";
import { codeText } from "../../../lib/code-text";
import { KeyValue, type KeyValueItem } from "../../../ui/key-value/key-value";
import type { Item } from "../api";

const code = (v: string) => codeText(`benefits.code.${v}`, v);
function fact(label: MessageId, value: string | number | undefined | null): KeyValueItem[] {
  return value == null || value === "" ? [] : [{ key: label, label: t(label), value }];
}
export function BenefitDetail({ item }: { item: Item }) {
  const scopeRef = item.scope.site_id ?? item.scope.scope_ref ?? item.scope.branch_id;
  const scope = [code(item.scope.scope_type), scopeRef].filter(Boolean).join(" · ");
  return <>
    <KeyValue density="dense" items={[
      ...fact("benefits.code", item.benefit_code), ...fact("benefits.category", t(item.category === "legal" ? "benefits.legal" : "benefits.extra")),
      ...fact("benefits.scope", scope), ...fact("benefits.coverage", item.coverage_label), ...fact("benefits.cost", item.cost_label),
      ...fact("benefits.coveredCount", item.covered_count != null ? fmtNumber(item.covered_count) : null),
      ...fact("benefits.annualCost", item.estimated_annual_cost_won != null ? fmtKrw(String(item.estimated_annual_cost_won)) : null),
      ...fact("benefits.employerRate", item.employer_rate_bps != null ? fmtNumber(item.employer_rate_bps) : null),
      ...fact("benefits.effective", item.effective_on && fmtDate(item.effective_on)), ...fact("benefits.retires", item.retires_on && fmtDate(item.retires_on)),
      ...fact("benefits.legalBasis", item.legal_basis), ...fact("benefits.note", item.note),
    ]} />
    <section><h3>{t("benefits.tiers")}</h3>{item.tiers.length ? <ul>{item.tiers.map(row =>
      <li key={row.id ?? row.tier_key}><strong>{row.value_label}</strong><KeyValue density="dense" items={[
        ...fact("benefits.key", row.tier_key), ...fact("benefits.basis", row.tier_basis),
        ...fact("benefits.amount", row.amount_won != null ? fmtKrw(String(row.amount_won)) : null),
        ...fact("benefits.period", row.limit_period && code(row.limit_period)), ...fact("benefits.criteria", JSON.stringify(row.criteria)),
      ]} /></li>)}</ul> : <p>{t("benefits.noTiers")}</p>}</section>
    <section><h3>{t("benefits.conditions")}</h3>{item.conditions.length ? <ul>{item.conditions.map(row =>
      <li key={row.id ?? row.condition_key}><strong>{row.display_label}</strong><KeyValue density="dense" items={[
        ...fact("benefits.key", row.condition_key), ...fact("benefits.kind", code(row.condition_kind)),
        ...fact("benefits.operator", code(row.operator)), ...fact("benefits.value", JSON.stringify(row.condition_value)), ...fact("benefits.policy", row.cedar_policy_ref),
      ]} /></li>)}</ul> : <p>{t("benefits.noConditions")}</p>}</section>
  </>;
}
