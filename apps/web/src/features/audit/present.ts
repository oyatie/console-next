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

export const consentCode = (code: string) => codeText(`audit.consents.code.${code}`, code);
