// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import { read } from "../../lib/query";
import { APPROVAL_ROLE, ORG_CHANGE_STATUS, label, labeled } from "../../lib/labels";
import type { components } from "@console/api/schema";

import type { ApprovalDecision, ApprovalQuery, ApprovalPage, ApprovalItem } from "@console/api/pending";
export type { ApprovalViewer, ApprovalItem, ApprovalDocument, ApprovalDecision } from "@console/api/pending";

const present = (item: components["schemas"]["ApprovalDocument"]): ApprovalItem => {
  const status = labeled(ORG_CHANGE_STATUS, item.status.key);
  return { ...item, status: { key: item.status.key, label: status.label, tone: status.tone ?? "neutral" },
    route: item.route.map(step => ({ ...step, label: label(APPROVAL_ROLE, step.role_key) })) };
};
const page = async (query: ApprovalQuery): Promise<ApprovalPage> => {
  const result = await unwrap(api.GET("/api/v1/approvals", { params: { query } }));
  return { ...result, items: result.items.map(present), focused: result.focused && present(result.focused) };
};

/** Canonical approval projection; queue membership, facets and preview fields are server decisions. */
export const approvalPages = (query: Omit<ApprovalQuery, "cursor">) => ({
  ...read("/api/v1/approvals", () => page(query), { query }),
  queryFn: ({ pageParam }: { pageParam: string | undefined }) => page({ ...query, cursor: pageParam }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: ApprovalPage) => last.next_cursor ?? undefined,
});

export const approvalDocumentQuery = (id: string) => read("/api/v1/approvals/{id}", async () => {
  const document = await unwrap(api.GET("/api/v1/approvals/{id}", { params: { path: { id } } }));
  return { ...document, ...present(document) };
}, { id });
export const decideApproval = (id: string, body: ApprovalDecision, key: string) =>
  unwrap(api.POST("/api/v1/approvals/{id}/decision", { params: { path: { id } }, headers: { "Idempotency-Key": key }, body }));
