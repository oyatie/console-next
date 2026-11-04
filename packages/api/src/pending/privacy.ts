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
/** Requested read: choices and date-only deadlines resolved by the server's registers and Cedar facts. */
export type PrivacyFilingOptions = {
  subject_user_id: string;
  as_of: string;
  controllers: { code: PrivacyFiling["controller"]; label: string; description: string }[];
  kinds: { code: PrivacyFiling["kinds"][number]; label: string; description: string; due_on: string | null; without_delay: boolean }[];
  detail_max_length: number;
  reply_email_masked: string | null;
};

/** The wire contract is generated from the existing rights domain. */
export type PrivacyPaths = Pick<import("../schema").paths,
  "/api/v1/privacy/rights-requests/mine" | "/api/v1/privacy/rights-requests"> & {
  "/api/v1/privacy/rights-requests/options": { get: { parameters: { query?: never }; responses: { 200: { content: { "application/json": PrivacyFilingOptions } } } } };
};
