// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Checklist } from "@console/api/pending";
import { t, type MessageId } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { liveApplying } from "../../../lib/live/live";
import { cursorPages } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { Banner } from "../../../ui/banner/banner";
import { GroupedQueue, type RowAction } from "./grouped-queue";
import { QuietQueue } from "./quiet-queue";
import { Card } from "../../../ui/card/card";
import { TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import type { InboxFilter } from "../domain/inbox-filter";

// Keep the Home preview short enough for the first viewport; full paging belongs to /inbox.
const HOME_PREVIEW_ROWS = 5;
const SOURCE_TEXT: Record<string, MessageId> = {
  registration_checks: "nts.title",
  entity_corrections: "entityRecord.corrections.title",
  support_access: "home.part.support", workflow: "home.part.decide", dispatch: "home.inbox.source.dispatch", support: "home.inbox.source.support", work_order: "home.inbox.source.workOrder", payroll: "accessCodes.domain.pay", governance: "home.inbox.source.governance",
  org_change: "home.part.changes", hr_exit: "home.part.exits", hr_lifecycle: "home.part.failedActions", hr_requests: "home.part.requests", hr_register: "home.review.register", hr_insurance: "home.part.insurance", hr_identity: "home.review.identity", hr_branch: "home.review.unplaced", hr_unplaced: "home.review.unplaced", hr_contract: "people.lifecycle.action.CONTRACT_RENEWAL", period_unlock: "home.part.unlocks", setup: "setup.title", grant_notice: "access.grant.title",
};
/** Every surface reads this server queue; filters, ownership and deadlines stay with its sources. */
export function InboxQueue({ preview = false, filter = "turn", setup, setupPhase = false, setupPending = false, action }: { preview?: boolean; filter?: InboxFilter; setup?: (c: Checklist) => ReactNode; setupPhase?: boolean; setupPending?: boolean; action?: RowAction } = {}) {
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter }), placeholderData: keepPreviousData, refetchOnMount: "always" });
  const [opened] = useState(Date.now);
  const [caughtUp, setCaughtUp] = useState(false);
  const rereading = !caughtUp && inbox.isFetching && inbox.dataUpdatedAt < opened;
  if (!rereading && !inbox.isPending && !caughtUp) setCaughtUp(true);
  const first = inbox.data?.pages[0];
  const applying = useSyncExternalStore(liveApplying.subscribe, liveApplying.get, liveApplying.get);
  const loading = setupPending || rereading || applying;
  return (
    <Card title={preview && !loading ? t("home.inbox.title") : undefined} titleId="inbox-title" label={t("home.inbox.title")} tools={first?.as_of ? <time dateTime={first.as_of}>{t("home.asOf", { time: fmtDateTime(first.as_of) })}</time> : loading || inbox.isPending ? <Skeleton decorative bones={["short"]} /> : null}>
      {!preview && !setupPhase && !first?.setup && !!first?.available_filters.length && <TabNav label={t("home.lanes")}>
        {first.available_filters.map(key => {
          const count = first.counts[key];
          return <Link key={key} to="/inbox" search={{ tab: key === "turn" ? undefined : key }} replace resetScroll={false} className={tabClass} aria-current={filter === key ? "page" : undefined} activeOptions={{ exact: true, includeSearch: true }}>
            {count ? t(count.total_is_exact ? "home.inbox.filterCount" : "home.inbox.filterCount.lower", { filter: t(`home.inbox.filter.${key}`), count: count.total }) : t(`home.inbox.filter.${key}`)}
          </Link>;
        })}
      </TabNav>}
      <QueryState q={loading ? { ...inbox, isPending: true, data: undefined } : inbox} layout="list">{(data) => {
          const pages = data.pages;
          const checklist = pages[0]?.setup;
          const rows = (preview ? pages.slice(0, 1) : pages).flatMap((page) => page.items).filter((item) => !checklist || !item.kind.startsWith("setup_"));
          const head = pages[0];
          const unavailable = [...new Map(pages.flatMap((page) => page.unavailable).map((part) => [part.source, part])).values()];
          if (!preview && (setupPhase || checklist)) return <EmptyState title={t("home.inbox.setup.title")} reason={null} actions={<Link to="/" className={buttonClass("primary")}>{t("shell.link.home")}</Link>} />;
          return <>
            {unavailable.map((part) => <Banner tone="danger" live="assertive" key={part.source} actions={<Button onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>{t("common.retry")}</Button>}>
              {t("home.inbox.unavailable", { part: t(SOURCE_TEXT[part.source] ?? "home.inbox.unknown") })} · {t("home.inbox.support", { reference: part.support_reference })}
            </Banner>)}
            {checklist && setup?.(checklist)}
            {!checklist && !head?.has_work && <EmptyState title={t("home.noWork.title")} reason={t("home.noWork.reason")} actions={rows.some((item) => item.kind === "account_security") ? undefined : <Link to="/account" className={buttonClass("primary")}>{t("shell.account")}</Link>} />}
            {rows.length > 0 ? <GroupedQueue items={preview ? rows.slice(0, HOME_PREVIEW_ROWS) : rows} action={action} /> : !checklist && head?.has_work && <QuietQueue page={head} filter={filter} partial={unavailable.length > 0} />}
            {!preview && inbox.hasNextPage && <Button disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{t("home.inbox.more")}</Button>}
          </>;
        }}</QueryState>
      {preview && first && (first.has_work || first.available_filters.length > 0) && !loading && !inbox.error && !first.setup && <Link to="/inbox">{t("home.inbox.viewInbox")}</Link>}
    </Card>
  );
}
