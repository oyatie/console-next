// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, paths } from "@console/api/schema";

type InboxQuery = NonNullable<paths["/api/v1/me/action-inbox"]["get"]["parameters"]["query"]>;
export type InboxFilter = NonNullable<InboxQuery["filter"]>;
// Parse the public API enum; available_filters remains authoritative for offered views.
export const INBOX_FILTERS = ["all", "turn", "waiting", "scheduled", "deadlines", "failures"] as const satisfies readonly InboxFilter[];
export const inboxFilter = (value: unknown): InboxFilter => INBOX_FILTERS.find(filter => filter === value) ?? "all";

/** Inbox tabs by my relation (ideal §2a); scheduled and failures are chips inside to-do. */
export const INBOX_TABS = ["turn", "waiting", "reference", "done"] as const;
export const TODO_CHIPS = ["scheduled", "failures"] as const;
/** What I postponed: a chip inside to-do, read on its own so the tab counts stay those of my open list. */
export const SNOOZED = "snoozed";
export const INBOX_VIEWS = [...INBOX_TABS, ...TODO_CHIPS, SNOOZED] as const;
export type InboxView = typeof INBOX_VIEWS[number];
// Older links (all, deadlines) land on to-do, whose buckets put overdue and due-soon first.
export const inboxView = (value: unknown): InboxView => INBOX_VIEWS.find(view => view === value) ?? "turn";
/** The queue read behind a view: reference, done and snoozed keep my turn read for the badge and tab counts. */
export const inboxReadFilter = (view: InboxView): InboxFilter => view === "reference" || view === "done" || view === SNOOZED ? "turn" : view;

const ATTENTION_FILTERS = ["all", "approvals", "today", "overdue"] as const;
export type AttentionFilter = typeof ATTENTION_FILTERS[number];
export type AttentionInboxItem = components["schemas"]["ActionInboxItem"] & { age_days?: number | null };
export type AttentionInboxResponse = Omit<components["schemas"]["ActionInboxResponse"], "items"> & {
  items: AttentionInboxItem[];
  attention_filters?: { key: AttentionFilter; total: number; total_is_exact: boolean }[];
};
export const isAttentionFilter = (value: unknown): value is AttentionFilter => ATTENTION_FILTERS.some(filter => filter === value);
export type SnoozePreset = NonNullable<components["schemas"]["ActionInboxResponse"]["snooze_presets"]>[number];
