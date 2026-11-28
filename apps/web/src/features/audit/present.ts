// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { Finding } from "./api";
import { codeText } from "../../lib/code-text";

export const vaultCode = (code: string) => codeText(`audit.vault.code.${code}`, code);

export const findingCode = (code: Finding["status"] | Finding["severity"]) => t(`audit.findings.code.${code}`);
export function findingDetector(id: string) {
  if (id === "anomaly.self_approval") return t("audit.findings.selfApproval");
  if (id === "anomaly.price_outlier") return t("audit.findings.priceOutlier");
  return id;
}

export const lifecycleCode = (state: string) => codeText(`audit.lifecycle.code.${state}`, state);

/** Only the lifecycle service writes this target type and composite id into Audit. */
export function lifecycleTarget(type?: string | null, id?: string | null) {
  const parts = type === "object_lifecycle" && id ? /^([a-z][a-z0-9_]{1,63}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id) : null;
  return parts ? { objectType: parts[1]!, objectId: parts[2]! } : undefined;
}
export const consentCode = (code: string) => codeText(`audit.consents.code.${code}`, code);

function formatSnapValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function buildSnapDiffRows(beforeSnap: unknown, afterSnap: unknown) {
  const beforeObj = beforeSnap && typeof beforeSnap === "object" && !Array.isArray(beforeSnap) ? (beforeSnap as Record<string, unknown>) : null;
  const afterObj = afterSnap && typeof afterSnap === "object" && !Array.isArray(afterSnap) ? (afterSnap as Record<string, unknown>) : null;
  if (!beforeObj && !afterObj) {
    if (beforeSnap === undefined && afterSnap === undefined) return [];
    return [{ key: "payload", label: t("audit.detail.diff"), value: `${formatSnapValue(beforeSnap)} → ${formatSnapValue(afterSnap)}` }];
  }
  const keys = [...new Set([...Object.keys(beforeObj ?? {}), ...Object.keys(afterObj ?? {})])];
  return keys.map(key => ({
    key,
    label: key,
    value: `${t("audit.detail.before")}: ${formatSnapValue(beforeObj?.[key])} · ${t("audit.detail.after")}: ${formatSnapValue(afterObj?.[key])}`,
  }));
}
