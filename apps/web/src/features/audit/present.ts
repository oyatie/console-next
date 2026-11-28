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
