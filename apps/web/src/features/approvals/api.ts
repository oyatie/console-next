// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { describeOp } from "../../reference/org/present";
import { read } from "../../lib/query";
import { APPROVAL_ROLE, ORG_CHANGE_STATUS, label, labeled } from "../../lib/labels";
import type { components } from "@console/api/schema";

import type { ApprovalDecision, ApprovalQuery, ApprovalPage, ApprovalItem } from "@console/api/pending";
export type { ApprovalViewer, ApprovalItem, ApprovalDocument, ApprovalDecision } from "@console/api/pending";

const sourceLabel = (source: { key: string; label?: string }) => source.key === "org_change" ? t("approvals.source.orgChange") : source.label ?? source.key;
const present = (item: components["schemas"]["ApprovalDocument"]): ApprovalItem => {
  const status = labeled(ORG_CHANGE_STATUS, item.status.key);
  return { ...item, source: { ...item.source, label: sourceLabel(item.source) },
    facts: [...item.facts, ...(item.effective_date ? [{ key: "effective_date", label: t("approvals.field.effectiveDate"), value: fmtDate(item.effective_date) }] : [])], status: { key: item.status.key, label: status.label, tone: status.tone ?? "neutral" },
    route: item.route.map(step => ({ ...step, label: label(APPROVAL_ROLE, step.role_key) })) };
};
const page = async (query: ApprovalQuery): Promise<ApprovalPage> => {
  const result = await unwrap(api.GET("/api/v1/approvals", { params: { query } }));
  return { ...result, items: result.items.map(present), focused: result.focused && present(result.focused), sources: result.sources.map(source => ({ ...source, label: sourceLabel(source) })) };
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
  const name = (id?: string | null) => id ? document.proposal_names?.[id] : undefined;
  return { ...document, ...present(document), body: [
    ...document.body,
    ...(document.proposal ?? []).map((op, index) => ({ key: `proposal-${index}`, label: t("approvals.field.proposal"),
      value: describeOp(op, { unit: name, region: name, branch: name }) })),
  ] };
}, { id });
export const decideApproval = (id: string, body: ApprovalDecision, key: string) =>
  unwrap(api.POST("/api/v1/approvals/{id}/decision", { params: { path: { id }, header: { "Idempotency-Key": key } }, body }));
