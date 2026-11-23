// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useQuery } from "@tanstack/react-query";
import { useLiveHold } from "../../../lib/live/hold";
import { freshOnOpen } from "../../../lib/query";
import { useTabSearch } from "../../../lib/react/use-tab-search";
import { Card } from "../../../ui/card/card";
import { Page } from "../../../ui/page/page";
import { meQuery } from "../api";
import { inboxReadFilter, inboxView, INBOX_VIEWS, SNOOZED, type InboxView } from "../domain/inbox-filter";
import type { RowAction } from "./grouped-queue";
import { DoneList, ReferenceList } from "./inbox-finished";
import { InboxQueue } from "./inbox-queue";
import { InboxRead } from "./inbox-read";
import { InboxTabs } from "./inbox-tabs";
import { SnoozedList } from "./snooze";
import { useInboxRead } from "./use-inbox-read";
import { WorklistConsole, type WorklistConsoleProps } from "./worklist-console";

type ConsoleSlots = Pick<
  WorklistConsoleProps,
  "inlineRowAction" | "recordBody" | "recordFooter" | "orgNeed" | "canOrgStructure"
>;

export function InboxPage({ action, ...slots }: { action?: RowAction } & ConsoleSlots) {
  const tab = useTabSearch(INBOX_VIEWS.map(id => ({ id })));
  const view = inboxView(tab.selected);
  return (
    <InboxRead filter={inboxReadFilter(view)}>
      <InboxContent view={view} action={action} {...slots} />
    </InboxRead>
  );
}

function InboxContent({ view, action, ...slots }: { view: InboxView; action?: RowAction } & ConsoleSlots) {
  const me = freshOnOpen(useQuery({ ...meQuery, refetchOnMount: "always" }));
  const { inbox } = useInboxRead();
  const first = inbox.data?.pages[0];
  const asOf = !me.isPending && me.data?.tenant?.phase !== "SETUP" && !first?.setup && !inbox.error ? first?.as_of : undefined;
  useLiveHold(!me.isPending && !!inbox.data?.pages.some(page => page.items.length > 0), true);
  return (
    <WorklistConsole
      mode="inbox"
      view={view}
      meRead={me}
      title={t("home.inbox.title")}
      titleId="inbox-title"
      setupPhase={me.data?.tenant?.phase === "SETUP"}
      action={action}
      {...slots}
      baseline={() => (
        <Page
          floorplan="P-03"
          head={{
            title: t("home.inbox.title"),
            titleId: "inbox-title",
            tools: asOf ? (
              <time className="muted t-sm" dateTime={asOf}>
                {t("home.asOf", { time: fmtDateTime(asOf) })}
              </time>
            ) : undefined,
          }}
          q={me}
        >
          {user =>
            view === "reference" || view === "done" || view === SNOOZED ? (
              <Card label={t("home.inbox.title")}>
                <InboxTabs view={view} />
                {view === "reference" ? <ReferenceList /> : view === "done" ? <DoneList /> : <SnoozedList />}
              </Card>
            ) : (
              <InboxQueue filter={view} action={action} setupPhase={user.tenant?.phase === "SETUP"} />
            )
          }
        </Page>
      )}
    />
  );
}
