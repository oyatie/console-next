// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import { read } from "../../lib/query";

import type { ApprovalDecision, ApprovalQuery, ApprovalPage } from "@console/api/pending";
export type { ApprovalViewer, ApprovalItem, ApprovalDocument, ApprovalDecision } from "@console/api/pending";

const page = (query: ApprovalQuery) => unwrap(api.GET("/api/v1/approvals", { params: { query } }));

/** Canonical approval projection; queue membership, facets and preview fields are server decisions. */
export const approvalPages = (query: Omit<ApprovalQuery, "cursor">) => ({
  ...read("/api/v1/approvals", () => page(query), { query }),
  queryFn: ({ pageParam }: { pageParam: string | undefined }) => page({ ...query, cursor: pageParam }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: ApprovalPage) => last.next_cursor ?? undefined,
});

export const approvalDocumentQuery = (id: string) => read("/api/v1/approvals/{id}", () => unwrap(api.GET("/api/v1/approvals/{id}", { params: { path: { id } } })), { id });
export const decideApproval = (id: string, body: ApprovalDecision, key: string) =>
  unwrap(api.POST("/api/v1/approvals/{id}/decision", { params: { path: { id } }, headers: { "Idempotency-Key": key }, body }));
