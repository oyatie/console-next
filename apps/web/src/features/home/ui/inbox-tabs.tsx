// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { ToggleButton } from "../../../ui/button/button";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import { INBOX_TABS, TODO_CHIPS, type InboxView } from "../domain/inbox-filter";
import { useInboxRead } from "./use-inbox-read";
import css from "./inbox-queue.module.css";

type Count = { total: number; total_is_exact: boolean } | undefined;
// An exact count stays a number (TabCount formats it); a lower bound arrives formatted with its "+".
const shown = (count: Count) => count && (count.total_is_exact ? count.total : `${fmtNumber(count.total)}+`);
const chipCount = (count: Count) => count ? `${fmtNumber(count.total)}${count.total_is_exact ? "" : "+"}` : "";

/** To do, requested, reference and done tabs; scheduled and failures are chips beside them when the server offers them. */
export function InboxTabs({ view }: { view: InboxView }) {
  const first = useInboxRead().inbox.data?.pages[0];
  const navigate = useNavigate();
  const offered: readonly string[] = first?.available_filters ?? [];
  const current = (TODO_CHIPS as readonly string[]).includes(view) ? "turn" : view;
  // The tabs are fixed by relation and paint before the read with empty count slots, so nothing moves when it
  // lands; only the chips depend on what the server offers, and they share the tab line.
  const chips = TODO_CHIPS.filter(key => offered.includes(key));
  return <div className={css.tabRow}>
    <TabNav label={t("home.lanes")} overflow="scroll">
      {INBOX_TABS.map(tab => <Link key={tab} to="/inbox" search={{ tab: tab === "turn" ? undefined : tab }} replace resetScroll={false} activeOptions={{ exact: true, includeSearch: true }} className={tabClass} aria-current={current === tab ? "page" : undefined}>
        {t(`home.inbox.tab.${tab}`)}{tab === "turn" || tab === "waiting" ? <>{" "}<TabCount>{shown(first?.counts[tab])}</TabCount></> : null}
      </Link>)}
    </TabNav>
    {chips.length > 0 && <div role="group" aria-label={t("home.inbox.tab.turn")} className={css.attention}>
      {chips.map(key => <ToggleButton key={key} look="chip" pressed={view === key} count={chipCount(first?.counts[key])} onClick={() => void navigate({ to: "/inbox", search: { tab: view === key ? undefined : key }, replace: true, resetScroll: false })}>
        {t(`home.inbox.filter.${key}`)}
      </ToggleButton>)}
    </div>}
  </div>;
}
