// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import { read } from "../../lib/query";
import type { ApprovalBox } from "./domain/inbox";

export type ApprovalViewer =
  | { kind: "org_change" | "employee" | "exit_case" | "support_session" | "change_request" | "period_lock" | "statutory"; id: string }
  | { kind: "account"; id?: string };

export type ApprovalItem = {
  id: string;
  box: ApprovalBox;
  title: string;
  summary: string;
  document_no?: string | null;
  source: { key: string; label: string };
  status: { key: string; label: string; tone: "ok" | "warn" | "danger" | "info" | "neutral" };
  requester?: { id: string; name: string; role?: string | null } | null;
  requested_at: string;
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
type ApprovalDecisionReceipt = { message: string };

type ApprovalPage = {
  items: ApprovalItem[];
  focused?: ApprovalItem | null;
  counts: Record<ApprovalBox, number>;
  sources: { key: string; label: string; count: number }[];
  next_cursor?: string | null;
};

type ApprovalQuery = { box: ApprovalBox; q?: string; source?: string; focus?: string; cursor?: string };
type UntypedGet = (path: string, init: { params: { query: ApprovalQuery } }) => Promise<{ data?: ApprovalPage; error?: unknown; response: Response }>;
type UntypedDetailGet = (path: string) => Promise<{ data?: ApprovalDocument; error?: unknown; response: Response }>;
type UntypedPost = (path: string, init: { headers: { "Idempotency-Key": string }; body: ApprovalDecision }) => Promise<{ data?: ApprovalDecisionReceipt; error?: unknown; response: Response }>;
const getUntyped = api.GET as unknown as UntypedGet;
const getDetailUntyped = api.GET as unknown as UntypedDetailGet;
const postUntyped = api.POST as unknown as UntypedPost;
const page = (query: ApprovalQuery) => unwrap(getUntyped("/api/v1/approvals", { params: { query } }));
const documentPath = (id: string) => `/api/v1/approvals/${encodeURIComponent(id)}`;

/** Canonical approval projection; queue membership, facets and preview fields are server decisions. */
export const approvalPages = (query: Omit<ApprovalQuery, "cursor">) => ({
  ...read("/api/v1/approvals", () => page(query), { query }),
  queryFn: ({ pageParam }: { pageParam: string | undefined }) => page({ ...query, cursor: pageParam }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: ApprovalPage) => last.next_cursor ?? undefined,
});

export const approvalDocumentQuery = (id: string) => read("/api/v1/approvals/{id}", () => unwrap(getDetailUntyped(documentPath(id))), { id });
export const decideApproval = (id: string, body: ApprovalDecision, key: string) =>
  unwrap(postUntyped(`${documentPath(id)}/decision`, { headers: { "Idempotency-Key": key }, body }));
