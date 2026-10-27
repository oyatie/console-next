// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

export type InboxFilter = components["schemas"]["ActionInboxResponse"]["available_filters"][number];
// Parse the public API enum; available_filters remains authoritative for offered views.
export const INBOX_FILTERS = ["turn", "waiting", "scheduled", "deadlines", "failures"] as const satisfies readonly InboxFilter[];
export const inboxFilter = (value: unknown): InboxFilter => INBOX_FILTERS.find(filter => filter === value) ?? "turn";
