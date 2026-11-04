// SPDX-License-Identifier: LicenseRef-Proprietary
/** Requested self-service projection; labels and clocks are resolved by the server's registers. */
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
  outcomes: { kind_label: string; outcome_label: string; reason_label: string | null; note: string | null }[];
  notified_at: string | null;
  objection_method: string | null;
  retention_notice: string | null;
};
export type PrivacyRightsPage = { items: PrivacyRightsReceipt[]; next_cursor: string | null };

export type PrivacyPaths = {
  /** Cedar scopes this read to the subject, in the current realm; no grant is needed in the client. */
  "/api/v1/privacy/rights-requests/mine": {
    get: {
      parameters: { query?: { cursor?: string } };
      responses: { 200: { headers: Record<string, unknown>; content: { "application/json": PrivacyRightsPage } } };
    };
  };
};
