// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { meQuery } from "../api";
import type { RowAction } from "./grouped-queue";
import { InboxQueue } from "./inbox-queue";
import { inboxFilter, INBOX_FILTERS } from "../domain/inbox-filter";
import { useTabSearch } from "../../../lib/react/use-tab-search";
import { cursorPages, freshOnOpen } from "../../../lib/query";
import { useLiveHold } from "../../../lib/live/hold";
import { Page } from "../../../ui/page/page";

export function InboxPage({ action }: { action?: RowAction }) {
  const me = freshOnOpen(useQuery({ ...meQuery, refetchOnMount: "always" }));
  const tab = useTabSearch(INBOX_FILTERS.map(id => ({ id })));
  const filter = inboxFilter(tab.selected);
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter }), refetchOnMount: "always" });
  useLiveHold(!me.isPending && !!inbox.data?.pages.some(page => page.items.length > 0), true);
  return <Page floorplan="list" head={{ title: t("home.inbox.title"), titleId: "inbox-title" }} q={me}>
    {user => <InboxQueue filter={filter} action={action} setupPhase={user.tenant?.phase === "SETUP"} />}
  </Page>;
}
