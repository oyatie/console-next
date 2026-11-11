// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { ToggleButton } from "../../../ui/button/button";
import { TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import { INBOX_TABS, TODO_CHIPS, type InboxView } from "../domain/inbox-filter";
import { useInboxRead } from "./use-inbox-read";
import css from "./inbox-queue.module.css";

type Count = { total: number; total_is_exact: boolean } | undefined;
const counted = (label: string, count: Count) => count ? t(count.total_is_exact ? "home.inbox.filterCount" : "home.inbox.filterCount.lower", { filter: label, count: count.total }) : label;

/** To do, requested and done tabs; scheduled and failures are chips under to-do when the server offers them. */
export function InboxTabs({ view }: { view: InboxView }) {
  const first = useInboxRead().inbox.data?.pages[0];
  const navigate = useNavigate();
  const offered: readonly string[] = first?.available_filters ?? [];
  const chip = (TODO_CHIPS as readonly string[]).includes(view);
  const current = chip ? "turn" : view;
  const tabs = INBOX_TABS.filter(tab => tab !== "waiting" || offered.includes(tab));
  const chips = TODO_CHIPS.filter(key => offered.includes(key));
  // Like the lane row before it, the tabs wait for the first read so their counts never push them aside.
  if (!first) return null;
  return <>
    <TabNav label={t("home.lanes")} overflow="scroll">
      {tabs.map(tab => <Link key={tab} to="/inbox" search={{ tab: tab === "turn" ? undefined : tab }} replace resetScroll={false} activeOptions={{ exact: true, includeSearch: true }} className={tabClass} aria-current={current === tab ? "page" : undefined}>
        {counted(t(`home.inbox.tab.${tab}`), tab === "turn" || tab === "waiting" ? first?.counts[tab] : undefined)}
      </Link>)}
    </TabNav>
    {current === "turn" && chips.length > 0 && <div role="group" aria-label={t("home.inbox.tab.turn")} className={css.attention}>
      {chips.map(key => {
        const count = first?.counts[key];
        return <ToggleButton key={key} look="chip" pressed={view === key} count={count ? `${fmtNumber(count.total)}${count.total_is_exact ? "" : "+"}` : ""} onClick={() => void navigate({ to: "/inbox", search: { tab: view === key ? undefined : key }, replace: true, resetScroll: false })}>
          {t(`home.inbox.filter.${key}`)}
        </ToggleButton>;
      })}
    </div>}
  </>;
}
