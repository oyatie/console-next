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

type ApprovalPage = {
  items: ApprovalItem[];
  focused?: ApprovalItem | null;
  counts: Record<ApprovalBox, number>;
  sources: { key: string; label: string; count: number }[];
  next_cursor?: string | null;
};

type ApprovalQuery = { box: ApprovalBox; q?: string; source?: string; focus?: string; cursor?: string };
type UntypedGet = (path: string, init: { params: { query: ApprovalQuery } }) => Promise<{ data?: ApprovalPage; error?: unknown; response: Response }>;
const getUntyped = api.GET as unknown as UntypedGet;
const page = (query: ApprovalQuery) => unwrap(getUntyped("/api/v1/approvals", { params: { query } }));

/** Canonical approval projection; queue membership, facets and preview fields are server decisions. */
export const approvalPages = (query: Omit<ApprovalQuery, "cursor">) => ({
  ...read("/api/v1/approvals", () => page(query), { query }),
  queryFn: ({ pageParam }: { pageParam: string | undefined }) => page({ ...query, cursor: pageParam }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: ApprovalPage) => last.next_cursor ?? undefined,
});
