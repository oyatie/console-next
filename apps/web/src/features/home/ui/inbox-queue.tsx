// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Checklist } from "@console/api/pending";
import { t, type MessageId } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { liveApplying } from "../../../lib/live/live";
import { QueryState } from "../../../lib/react/query-state";
import { Button, ToggleButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { Banner } from "../../../ui/banner/banner";
import { GroupedQueue, type RowAction } from "./grouped-queue";
import { QuietQueue } from "./quiet-queue";
import { Card } from "../../../ui/card/card";
import { TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import { isAttentionFilter, type AttentionInboxResponse, type InboxFilter } from "../domain/inbox-filter";
import { InboxRead } from "./inbox-read";
import { InboxReadContext, useInboxRead } from "./use-inbox-read";
import css from "./inbox-queue.module.css";

// Keep the Home preview short enough for the first viewport; full paging belongs to /inbox.
const HOME_PREVIEW_ROWS = 5;
const SOURCE_TEXT: Record<string, MessageId> = {
  privacy_requests: "home.inbox.privacyRequest",
  registration_checks: "nts.title",
  entity_corrections: "entityRecord.corrections.title",
  support_access: "home.part.support", workflow: "home.part.decide", dispatch: "home.inbox.source.dispatch", support: "home.inbox.source.support", work_order: "home.inbox.source.workOrder", payroll: "accessCodes.domain.pay", governance: "home.inbox.source.governance",
  org_change: "home.part.changes", hr_exit: "home.part.exits", hr_lifecycle: "home.part.failedActions", hr_requests: "home.part.requests", hr_register: "home.review.register", hr_insurance: "home.part.insurance", hr_identity: "home.review.identity", hr_branch: "home.review.unplaced", hr_unplaced: "home.review.unplaced", hr_contract: "people.lifecycle.action.CONTRACT_RENEWAL", period_unlock: "home.part.unlocks", setup: "setup.title", grant_notice: "access.grant.title",
};
/** Every surface reads this server queue; filters, ownership and deadlines stay with its sources. */
type Props = { preview?: boolean; filter?: InboxFilter; setup?: (c: Checklist) => ReactNode; setupPhase?: boolean; setupPending?: boolean; action?: RowAction };
export function InboxQueue(props: Props = {}) {
  const read = useContext(InboxReadContext);
  return read ? <Queue {...props} /> : <InboxRead preview={props.preview} filter={props.filter}><Queue {...props} /></InboxRead>;
}

function Queue({ preview = false, filter = "turn", setup, setupPhase = false, setupPending = false, action }: Props) {
  const { inbox, attention, setAttention } = useInboxRead();
  const [opened] = useState(Date.now);
  const [caughtUp, setCaughtUp] = useState(false);
  const rereading = !caughtUp && inbox.isFetching && inbox.dataUpdatedAt < opened;
  if (!rereading && !inbox.isPending && !caughtUp) setCaughtUp(true);
  const first = inbox.data?.pages[0] as AttentionInboxResponse | undefined;
  const applying = useSyncExternalStore(liveApplying.subscribe, liveApplying.get, liveApplying.get);
  const loading = setupPending || rereading || applying;
  const tools = preview ? (first?.as_of ? <time className="muted t-sm" dateTime={first.as_of}>{t("home.asOf", { time: fmtDateTime(first.as_of) })}</time> : loading || inbox.isPending ? <Skeleton decorative bones={["short"]} /> : null) : undefined;
  return (
    <Card title={preview && !loading ? t("home.inbox.title") : undefined} titleId={preview ? "inbox-title" : undefined} label={t("home.inbox.title")} tools={tools}>
      {preview && !setupPhase && !first?.setup && (first?.has_work || !!first?.available_filters.length) && first?.attention_filters?.length ? <div role="group" aria-label={t("home.attention.label")} className={css.attention}>
        {first.attention_filters.filter(({ key }) => isAttentionFilter(key)).map(({ key, total, total_is_exact }) => <ToggleButton key={key} look="chip" pressed={attention === key} count={`${fmtNumber(total)}${total_is_exact ? "" : "+"}`} onClick={() => setAttention(key)}>
          {t(`home.attention.${key}`)}
        </ToggleButton>)}
      </div> : null}
      {(!preview || !first?.attention_filters?.length) && !setupPhase && !first?.setup && !!first?.available_filters.length && <TabNav label={t("home.lanes")} overflow="scroll">
        {(preview ? first.available_filters : ["all", ...first.available_filters] as InboxFilter[]).map(key => {
          const count = key === "all" ? (first.counts.all ?? (filter === "all" ? { total: first.total, total_is_exact: first.total_is_exact } : undefined)) : first.counts[key];
          return <Link key={key} to="/inbox" search={{ tab: key === "all" ? undefined : key }} replace={!preview} resetScroll={preview ? undefined : false} className={tabClass} aria-current={filter === key ? (preview ? true : "page") : undefined} activeOptions={{ exact: true, includeSearch: true }}>
            {count ? t(count.total_is_exact ? "home.inbox.filterCount" : "home.inbox.filterCount.lower", { filter: t(`home.inbox.filter.${key}`), count: count.total }) : t(`home.inbox.filter.${key}`)}
          </Link>;
        })}
      </TabNav>}
      <QueryState q={loading ? { ...inbox, isPending: true, data: undefined } : inbox} layout="list">{(data) => {
          const pages = data.pages as AttentionInboxResponse[];
          const checklist = pages[0]?.setup;
          let rows = (preview ? pages.slice(0, 1) : pages).flatMap((page) => page.items).filter((item) => !checklist || !item.kind.startsWith("setup_"));
          if (!preview && (setupPhase || checklist)) rows = rows.filter(item => item.kind === "privacy_request");
          const head = pages[0];
          const unavailable = [...new Map(pages.flatMap((page) => page.unavailable).map((part) => [part.source, part])).values()];
          const noWork = !head?.has_work && unavailable.length === 0;
          if (!preview && (setupPhase || checklist) && !rows.length && !unavailable.length && !inbox.hasNextPage) return <EmptyState title={t("home.inbox.setup.title")} reason={null} actions={<Link to="/" className={buttonClass("primary")}>{t("shell.link.home")}</Link>} />;
          return <>
            {unavailable.map((part) => <Banner tone="danger" live="assertive" key={part.source} actions={<Button onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>{t("common.retry")}</Button>}>
              {t("home.inbox.unavailable", { part: t(SOURCE_TEXT[part.source] ?? "home.inbox.unknown") })} · {t("home.inbox.support", { reference: part.support_reference })}
            </Banner>)}
            {checklist && setup?.(checklist)}
            {!checklist && noWork && <EmptyState title={t("home.noWork.title")} reason={t("home.noWork.reason")} actions={rows.some((item) => item.kind === "account_security") ? undefined : <Link to="/account" className={buttonClass("primary")}>{t("shell.account")}</Link>} />}
            {rows.length > 0 ? <GroupedQueue items={preview ? rows.slice(0, HOME_PREVIEW_ROWS) : rows} action={action} /> : !checklist && !noWork && head && <QuietQueue page={head} filter={preview && attention !== "all" ? attention : filter} partial={unavailable.length > 0} />}
            {!preview && inbox.hasNextPage && <Button disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{t("home.inbox.more")}</Button>}
          </>;
        }}</QueryState>
      {preview && first && (first.has_work || first.available_filters.length > 0) && !loading && !inbox.error && !first.setup && <Link to="/inbox">{t("home.inbox.viewInbox")}</Link>}
    </Card>
  );
}
