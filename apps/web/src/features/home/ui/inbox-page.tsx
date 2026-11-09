// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useQuery } from "@tanstack/react-query";
import { meQuery } from "../api";
import type { RowAction } from "./grouped-queue";
import { InboxQueue } from "./inbox-queue";
import { inboxFilter, INBOX_FILTERS } from "../domain/inbox-filter";
import { useTabSearch } from "../../../lib/react/use-tab-search";
import { freshOnOpen } from "../../../lib/query";
import { InboxRead } from "./inbox-read";
import { useInboxRead } from "./use-inbox-read";
import { useLiveHold } from "../../../lib/live/hold";
import { Page } from "../../../ui/page/page";

export function InboxPage({ action }: { action?: RowAction }) {
  const tab = useTabSearch(INBOX_FILTERS.map(id => ({ id })));
  const filter = inboxFilter(tab.selected);
  return <InboxRead filter={filter}><InboxContent filter={filter} action={action} /></InboxRead>;
}

function InboxContent({ filter, action }: { filter: ReturnType<typeof inboxFilter>; action?: RowAction }) {
  const me = freshOnOpen(useQuery({ ...meQuery, refetchOnMount: "always" }));
  const { inbox } = useInboxRead();
  const first = inbox.data?.pages[0];
  const asOf = !me.isPending && me.data?.tenant?.phase !== "SETUP" && !first?.setup && !inbox.error ? first?.as_of : undefined;
  useLiveHold(!me.isPending && !!inbox.data?.pages.some(page => page.items.length > 0), true);
  return <Page floorplan="P-03" head={{ title: t("home.inbox.title"), titleId: "inbox-title", tools: asOf ? <time className="muted t-sm" dateTime={asOf}>{t("home.asOf", { time: fmtDateTime(asOf) })}</time> : undefined }} q={me}>
    {user => <InboxQueue filter={filter} action={action} setupPhase={user.tenant?.phase === "SETUP"} />}
  </Page>;
}
