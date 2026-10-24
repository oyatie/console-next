// SPDX-License-Identifier: LicenseRef-Proprietary
import type { CheckAnswer } from "./api";
import type { BusinessRegistration } from "@console/api/pending";
import { t } from "@console/i18n";
import { labeled, VERIFICATION } from "../../lib/labels";

export function verificationState(registration: BusinessRegistration) {
  return registration.verification_tier === "NONE" && registration.unverified_reason === "SERVICE_UNAVAILABLE"
    ? { tone: "neutral" as const, label: t("nts.state.unavailable") }
    : labeled(VERIFICATION, registration.verification_tier);
}

export function checkState(answer?: Partial<CheckAnswer> | null, available = true) {
  if (!available || (answer && !answer.status_code && answer.valid !== "01")) return { tone: "neutral" as const, label: t("nts.state.unavailable") };
  return labeled(VERIFICATION, answer?.valid === "01" ? "T2" : answer?.status_code && !answer.not_registered ? "T1" : "NONE");
}
