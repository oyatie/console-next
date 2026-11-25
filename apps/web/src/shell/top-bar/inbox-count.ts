// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { cursorRead } from "../../lib/query";

export type InboxPage = components["schemas"]["ActionInboxResponse"];
type InboxRead = UseInfiniteQueryResult<InfiniteData<InboxPage>>;
type Shown = { page?: InboxPage; at: number };

// Off the queue pages the count is a background read with a key of its own: a command there re-reads the page first
// and the count a moment later (lib/query), so the header never adds a heavy read to the page's own.
export const countRead = { ...cursorRead<InboxPage>("/api/v1/me/action-inbox", { filter: "turn", background: true }, cursor =>
  unwrap(api.GET("/api/v1/me/action-inbox", { params: { query: { filter: "turn", cursor } } } as never)) as Promise<InboxPage>), meta: { background: true } };

/** The answer a count shows next: a newer one replaces it; another key's older cached copy, or placeholder data, never does. */
export const newest = (shown: Shown, read: InboxRead): Shown =>
  read.isSuccess && !read.isPlaceholderData && read.dataUpdatedAt > shown.at ? { page: read.data.pages[0], at: read.dataUpdatedAt } : shown;

/**
 * The first inbox page a task count shows. Home, the inbox and other pages each key their own copy of the count:
 * arriving where an older copy is cached (and being re-read) must not step the count back to it.
 */
export function useNewestPage(read: InboxRead) {
  const [shown, setShown] = useState<Shown>({ at: 0 });
  const next = newest(shown, read);
  if (next !== shown) setShown(next);
  return read.isSuccess ? next.page ?? read.data.pages[0] : undefined;
}
