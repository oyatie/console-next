// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "../schema";
type S = components["schemas"];

/** Canonical projection over source records; no separate approval store. */
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

export type ApprovalDocument = ApprovalItem & {
  body: { key: string; label: string; value: string }[];
  revision: number;
  fingerprint: string;
  /** A consequence key (next_step, final); the screen owns the words. */
  consequence: string;
  opinion_max: number;
  /** The server offers a decision only where its source command takes one from this viewer. */
  my_actions: S["ApprovalDocumentDetail"]["my_actions"];
};

export type ApprovalDecision = S["ApprovalDecisionRequest"];

export type ApprovalPage = {
  items: ApprovalItem[];
  focused?: ApprovalItem | null;
  counts: Record<ApprovalBox, number>;
  sources: { key: string; label: string; count: number }[];
  next_cursor?: string | null;
};

export type ApprovalQuery = { box: ApprovalBox; q?: string; source?: string; focus?: string; cursor?: string };
