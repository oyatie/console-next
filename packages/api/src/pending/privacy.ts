// SPDX-License-Identifier: LicenseRef-Proprietary
/** Receipt view model; the wire API uses the generated per-kind domain contract. */
export type PrivacyRightsReceipt = {
  id: string;
  receipt_no: string;
  controller_label: string;
  kinds: { code: string; label: string }[];
  detail: string;
  received_at: string;
  status: { code: string; label: string; tone: "neutral" | "info" | "ok" | "warn" | "danger" };
  /** Null once closed, or when the statutory register cannot establish a deadline. */
  clock: { due_at: string; days_left: number; severity: "far" | "due" | "over" } | null;
  without_delay?: boolean;
  outcomes: { kind_label: string; outcome_label: string; reason_label: string | null; note: string | null }[];
  notified_at: string | null;
  objection_method: string | null;
  retention_notice: string | null;
};
export type PrivacyRightsPage = { items: PrivacyRightsReceipt[]; next_cursor: string | null };

export type PrivacyFiling = Omit<import("../schema").operations["filePrivacyRightsRequest"]["requestBody"]["content"]["application/json"], "step_up">;
/** Register and Cedar-resolved filing choices from the generated contract. */
export type PrivacyFilingOptions = import("../schema").operations["privacyRightsRequestOptions"]["responses"][200]["content"]["application/json"];

export type PrivacyDecisionInput = Omit<import("../schema").operations["decidePrivacyRightsRequest"]["requestBody"]["content"]["application/json"], "step_up">;
export type PrivacyPostponeInput = Omit<import("../schema").operations["postponePrivacyRightsRequest"]["requestBody"]["content"]["application/json"], "step_up">;
export type PrivacyOffAppReceipt = import("../schema").operations["receiveOffAppPrivacyRightsRequest"]["requestBody"]["content"]["application/json"];
export type PrivacyObjectionInput = import("../schema").operations["objectPrivacyRightsRequest"]["requestBody"]["content"]["application/json"];

export type PrivacyPaths = Pick<import("../schema").paths,
  | "/api/v1/privacy/rights-requests/mine"
  | "/api/v1/privacy/rights-requests"
  | "/api/v1/privacy/rights-requests/options"
  | "/api/v1/privacy/rights-requests/received"
  | "/api/v1/privacy/rights-requests/{id}"
  | "/api/v1/privacy/rights-requests/{id}/decide"
  | "/api/v1/privacy/rights-requests/{id}/postpone"
  | "/api/v1/privacy/rights-requests/{id}/objection">;
