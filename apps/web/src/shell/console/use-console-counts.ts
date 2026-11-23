// SPDX-License-Identifier: LicenseRef-Proprietary
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { inboxReadFilter, inboxView } from "../../features/home/domain/inbox-filter";
import { cursorPages, cursorRead } from "../../lib/query";

type InboxPage = components["schemas"]["ActionInboxResponse"];

const backgroundInboxRead = {
  ...cursorRead<InboxPage>(
    "/api/v1/me/action-inbox",
    { filter: "turn", background: true },
    cursor => unwrap(api.GET("/api/v1/me/action-inbox", { params: { query: { filter: "turn", cursor } } } as never)) as Promise<InboxPage>,
  ),
  meta: { background: true },
};

/**
 * Shares the exact `/api/v1/me/action-inbox` observer key with `NeedsMeMenu` and queue pages so the Console shell
 * displays live actionable `inbox` and `approvals` badges with zero extra network waterfalls.
 */
export function useConsoleCounts(enabled: boolean) {
  const { pathname, search } = useLocation();
  const home = pathname === "/";
  const fullInbox = pathname === "/inbox";
  const shared = home || fullInbox;
  const filter = fullInbox ? inboxReadFilter(inboxView(search.tab)) : "turn";

  const inbox = useInfiniteQuery({
    ...(shared
      ? cursorPages("/api/v1/me/action-inbox", home ? { filter, attention: "all" } : { filter })
      : backgroundInboxRead),
    enabled: query => enabled && (!shared || Boolean(query.state.data)),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

  const firstPage = inbox.isSuccess ? inbox.data.pages[0] : undefined;
  const turn = firstPage?.counts?.turn;
  const approvalsFilter = firstPage?.attention_filters?.find(entry => entry.key === "approvals");

  return {
    inboxCount: turn?.total && turn.total > 0 ? turn.total : undefined,
    inboxExact: turn?.total_is_exact ?? true,
    approvalsCount: approvalsFilter?.total && approvalsFilter.total > 0 ? approvalsFilter.total : undefined,
  };
}
