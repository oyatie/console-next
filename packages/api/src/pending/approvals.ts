// SPDX-License-Identifier: LicenseRef-Proprietary
/** Requested canonical projection over source records; no separate approval store. */
type ApprovalBox = "pending" | "upcoming" | "requested" | "reference" | "completed";

export type ApprovalViewer =
  | { kind: "org_change" | "employee" | "exit_case" | "support_session" | "change_request" | "period_lock" | "statutory"; id: string }
  | { kind: "account"; id?: string };

export type ApprovalItem = {
  id: string;
  box: ApprovalBox;
  title: string;
  summary: string;
  document_no?: string | null;
  decision_refusal?: string | null;
  source: { key: string; label: string };
  status: { key: string; label: string; tone: "ok" | "warn" | "danger" | "info" | "neutral" };
  requester?: { id: string; name: string; role?: string | null } | null;
  requested_at: string;
  /** The date the document takes effect, when it has one; shown beside the title in the list. */
  effective_date?: string | null;
  due_at?: string | null;
  facts: { key: string; label: string; value: string }[];
  route: { id: string; label: string; assignee?: string | null; state: "done" | "current" | "waiting" | "failed"; meta?: string | null }[];
  viewer?: ApprovalViewer | null;
};

type ApprovalReason = {
  codes: { code: string; label: string }[];
  other: string;
  memo_max: number;
};
type ApprovalReasonAction = { consequence: string; reason: ApprovalReason };

/** The server chooses the exact action variant after Cedar and SoD evaluation. */
type ApprovalActions =
  | { kind: "approve"; return?: ApprovalReasonAction; reject: ApprovalReasonAction }
  | { kind: "none" };

export type ApprovalDocument = ApprovalItem & {
  body: { key: string; label: string; value: string }[];
  revision: number;
  fingerprint: string;
  consequence: string;
  opinion_max: number;
  my_actions: ApprovalActions;
};

export type ApprovalDecision = {
  decision: "APPROVE" | "RETURN" | "REJECT";
  seen_fingerprint: string;
  opinion: string;
  reason_code?: string;
  note?: string;
};
export type ApprovalDecisionReceipt = { message: string };

export type ApprovalPage = {
  items: ApprovalItem[];
  focused?: ApprovalItem | null;
  counts: Record<ApprovalBox, number>;
  sources: { key: string; label: string; count: number }[];
  next_cursor?: string | null;
};

export type ApprovalQuery = { box: ApprovalBox; q?: string; source?: string; focus?: string; cursor?: string };
