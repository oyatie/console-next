// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { settingLabel, settingValue, type SummaryCopy } from "./summaries";

export type SettingEntry = components["schemas"]["SettingEntry"];
type SettingValue = components["schemas"]["SettingValue"];
export type SettingSectionId = "overview" | "approvals" | "operations" | "privacy" | "workplace" | "reasons" | "rollout";

export const SETTINGS_SECTIONS: readonly SettingSectionId[] = [
  "overview",
  "approvals",
  "operations",
  "privacy",
  "workplace",
  "reasons",
  "rollout",
];

export function parseSettingsSection(raw: unknown): SettingSectionId {
  return typeof raw === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(raw)
    ? (raw as SettingSectionId)
    : "overview";
}

export function settingSectionOf(key: string): "approvals" | "operations" | "privacy" {
  if (key.startsWith("approval.") || key === "corporate.small_company_383_proviso") return "approvals";
  if (
    key.startsWith("privacy.") ||
    key.startsWith("retention.") ||
    key.startsWith("audit.") ||
    key.startsWith("hr.record.") ||
    key.startsWith("access_log_review.") ||
    key === "people.void_pii_retention" ||
    key === "people.void_window"
  ) {
    return "privacy";
  }
  return "operations";
}

export function isSettingEditable(entry: SettingEntry, canChange: boolean): boolean {
  return canChange && entry.governance === "tenant";
}

export function formatEntryValue(entry: SettingEntry, value: SettingValue | null, t: SummaryCopy): string {
  if (value === null) return t("settingsHub.policy.undeclared");
  const formatted = settingValue(entry, value, t);
  if (formatted !== t("settingsHub.unknown")) return formatted;
  return typeof value === "string" ? value : String(value);
}

export function formatEntryDefault(entry: SettingEntry, t: SummaryCopy): string | null {
  if (entry.default === null) return null;
  return formatEntryValue(entry, entry.default, t);
}

export function formatEntryLabel(entry: SettingEntry, t: SummaryCopy): string {
  const translated = settingLabel(entry.key, t);
  if (translated === `settingsHub.key.${entry.key}`) return entry.key;
  return translated;
}

export function parseSettingInput(
  entry: SettingEntry,
  raw: string,
): { ok: true; value: SettingValue } | { ok: false; problem: "invalidNumber" | "outOfRange" | "invalidValue" } {
  if (entry.kind.type === "bool") return { ok: true, value: raw === "true" };
  if (entry.kind.type === "code") {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, problem: "invalidValue" };
    if (entry.kind.allowed && !entry.kind.allowed.includes(trimmed)) return { ok: false, problem: "invalidValue" };
    return { ok: true, value: trimmed };
  }
  if (!/^-?\d+$/.test(raw.trim())) return { ok: false, problem: "invalidNumber" };
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) return { ok: false, problem: "invalidNumber" };
  if (entry.kind.min != null && n < entry.kind.min) return { ok: false, problem: "outOfRange" };
  if (entry.kind.max != null && n > entry.kind.max) return { ok: false, problem: "outOfRange" };
  return { ok: true, value: n };
}
