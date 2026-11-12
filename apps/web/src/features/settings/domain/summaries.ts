// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, operations } from "@console/api/schema";
export type SummaryCopy = (id: string, values?: Record<string, string | number>) => string;

type S = components["schemas"];
type Entry = S["SettingEntry"];
type Read<O extends keyof operations> = operations[O] extends { responses: { 200: { content: { "application/json": infer D } } } } ? D : never;
export function domainSummary(data: S["CompanyDomainRequestState"], t: SummaryCopy, signInId?: string | null) {
  const domain = signInId?.split("@")[1];
  return domain ? [domain, ...(data.pending_domain ? [t("settingsHub.domain.pending", { domain: data.pending_domain })] : [])].join(" · ") : t("settingsHub.unknown");
}
export const numberingSummary = (data: S["EmployeeNumberRule"][], t: SummaryCopy) =>
  data.find(row => row.scope_kind === "TENANT")?.next_number ?? t("settingsHub.numbering.empty");
export function titlesSummary(data: Read<"listJobTitles">, t: SummaryCopy) {
  const counts = new Map<S["JobTitleKind"], number>();
  for (const row of data.items) if (row.active) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return [...counts].map(([kind, value]) => `${t(`enum.jobTitleKind.${kind}`)} ${t("settingsHub.number", { value })}`).join(" · ") || t("settingsHub.titles.empty");
}
export function periodsSummary(data: S["PeriodLockList"], t: SummaryCopy, fmtDate: (date: string) => string) {
  const latest = new Map<string, S["PeriodLock"]>();
  for (const row of data.items) if (row.active && (!latest.has(row.domain) || latest.get(row.domain)!.periodEnd < row.periodEnd)) latest.set(row.domain, row);
  return [...latest.values()].map(row => `${t(`enum.periodLockDomain.${row.domain}`)} · ${fmtDate(row.periodEnd)}`).join(" · ") || t("settingsHub.periods.empty");
}
export function settingLabel(key: string, t: SummaryCopy) {
  const id = `settingsHub.key.${key}`;
  return t(id);
}
export function settingValue(entry: Entry, value: Entry["value"], t: SummaryCopy) {
  if (entry.kind.type === "bool" && typeof value === "boolean") return t(value ? "settingsHub.on" : "settingsHub.off");
  if (entry.kind.type === "int" && typeof value === "number") return entry.kind.unit
    ? t(`settingsHub.unit.${entry.kind.unit}`, { value }) : t("settingsHub.number", { value });
  const id = `settingsHub.code.${value}`;
  return entry.kind.type === "code" ? t(id) : t("settingsHub.unknown");
}
export function approvalSummary(data: Read<"listSettings">, t: SummaryCopy, fmtDate: (date: string) => string) {
  const entries = data.items.filter(row => row.key.startsWith("approval.policy."));
  const unknown = !entries.length || entries.some(row => settingLabel(row.key, t) === t("settingsHub.unknown") || row.kind.type !== "code" || !row.kind.allowed?.includes(String(row.value)));
  const routed = entries.filter(row => row.value === "route");
  const value = unknown ? t("settingsHub.unknown") : routed.length
    ? routed.map(row => settingLabel(row.key, t)).join(", ") : t("settingsHub.approval.direct");
  const groups = new Map<string, string[]>();
  for (const row of entries) {
    const facts = [
      ...(["platform", "legal_entity", "workplace"].includes(row.source.layer) ? [t(`settingsHub.layer.${row.source.layer}`)] : []),
      ...(row.governance !== "tenant" ? [t(`settingsHub.governance.${row.governance}`)] : []),
    ].join(" · ");
    if (facts) groups.set(facts, [...(groups.get(facts) ?? []), settingLabel(row.key, t)]);
  }
  const hints = [...groups].map(([source, labels]) => t("settingsHub.source", { key: labels.length === entries.length ? t("settingsHub.all") : labels.join(", "), source }));
  hints.push(...entries.flatMap(row => row.scheduled.map(next => t("settingsHub.scheduled", { key: settingLabel(row.key, t), date: fmtDate(next.effective_from), value: settingValue(row, next.value, t) }))));
  if (!data.can_change) hints.push(t("settingsHub.readOnly"));
  return { value, hints };
}

/** How many fields the company has added and still uses. */
const rosterFieldsSummary = (data: Read<"listRosterFields">, t: SummaryCopy) => {
  const active = data.items.filter(row => row.active).length;
  return active ? t("settingsHub.number", { value: active }) : t("settingsHub.rosterFields.empty");
};
export const summaryFormatters = { domain: domainSummary, numbering: numberingSummary, titles: titlesSummary, rosterFields: rosterFieldsSummary, periods: periodsSummary };
