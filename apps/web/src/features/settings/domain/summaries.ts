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
export const titlesSummary = (data: Read<"listJobTitles">, t: SummaryCopy) => t("settingsHub.titles.count", {
  grades: data.items.filter(row => row.kind === "GRADE").length,
  positions: data.items.filter(row => row.kind === "POSITION").length,
});
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
  const hints = entries.flatMap(row => [
    ...(["platform", "legal_entity", "workplace"].includes(row.source.layer) ? [t("settingsHub.source", { key: settingLabel(row.key, t), source: t(`settingsHub.layer.${row.source.layer}`) })] : []),
    ...(row.governance !== "tenant" ? [t("settingsHub.governance", { key: settingLabel(row.key, t), governance: t(`settingsHub.governance.${row.governance}`) })] : []),
    ...row.scheduled.map(next => t("settingsHub.scheduled", { key: settingLabel(row.key, t), date: fmtDate(next.effective_from), value: settingValue(row, next.value, t) })),
  ]);
  if (!data.can_change) hints.push(t("settingsHub.readOnly"));
  return { value, hints };
}

export const summaryFormatters = { domain: domainSummary, numbering: numberingSummary, titles: titlesSummary, periods: periodsSummary };
