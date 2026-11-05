// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, paths } from "@console/api/schema";

type InboxQuery = NonNullable<paths["/api/v1/me/action-inbox"]["get"]["parameters"]["query"]>;
export type InboxFilter = NonNullable<InboxQuery["filter"]>;
// Parse the public API enum; available_filters remains authoritative for offered views.
export const INBOX_FILTERS = ["all", "turn", "waiting", "scheduled", "deadlines", "failures"] as const satisfies readonly InboxFilter[];
export const inboxFilter = (value: unknown): InboxFilter => INBOX_FILTERS.find(filter => filter === value) ?? "all";

const ATTENTION_FILTERS = ["all", "approvals", "today", "overdue"] as const;
export type AttentionFilter = typeof ATTENTION_FILTERS[number];
export type AttentionInboxItem = components["schemas"]["ActionInboxItem"] & { age_days?: number | null };
export type AttentionInboxResponse = Omit<components["schemas"]["ActionInboxResponse"], "items"> & {
  items: AttentionInboxItem[];
  attention_filters?: { key: AttentionFilter; total: number; total_is_exact: boolean }[];
};
export const isAttentionFilter = (value: unknown): value is AttentionFilter => ATTENTION_FILTERS.some(filter => filter === value);
