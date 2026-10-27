// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Checklist } from "@console/api/pending";
import { t, type MessageId } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { liveApplying } from "../../lib/live/live";
import { cursorPages } from "../../lib/query";
import { QueryState } from "../../lib/react/query-state";
import { Button } from "../../ui/button/button";
import { buttonClass } from "../../ui/button/button-class";
import { EmptyState } from "../../ui/empty-state";
import { Banner } from "../../ui/banner/banner";
import { GroupedQueue, type RowAction } from "./ui/grouped-queue";
import { QuietQueue } from "./ui/quiet-queue";
import { meQuery } from "./api";

const FILTERS = ["turn", "waiting", "scheduled", "deadlines", "failures"] as const;
type Filter = (typeof FILTERS)[number];
const SOURCE_TEXT: Record<string, MessageId> = {
  registration_checks: "nts.title",
  entity_corrections: "entityRecord.corrections.title",
  support_access: "home.part.support", workflow: "home.part.decide", dispatch: "home.inbox.source.dispatch", support: "home.inbox.source.support", work_order: "home.inbox.source.workOrder", payroll: "accessCodes.domain.pay", governance: "home.inbox.source.governance",
  org_change: "home.part.changes", hr_exit: "home.part.exits", hr_lifecycle: "home.part.failedActions", hr_requests: "home.part.requests", hr_register: "home.review.register", hr_insurance: "home.part.insurance", hr_identity: "home.review.identity", hr_branch: "home.review.unplaced", hr_unplaced: "home.review.unplaced", hr_contract: "people.lifecycle.action.CONTRACT_RENEWAL", period_unlock: "home.part.unlocks", setup: "setup.title", grant_notice: "access.grant.title",
};
/** Every surface reads this server queue; filters, ownership and deadlines stay with its sources. */
export function Home({ setup, setupPending = false, action }: { setup?: (c: Checklist) => ReactNode; setupPending?: boolean; action?: RowAction } = {}) {
  const [filter, setFilter] = useState<Filter>("turn");
  const me = useQuery(meQuery);
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter }), placeholderData: keepPreviousData, refetchOnMount: "always" });
  const [opened] = useState(Date.now);
  const [caughtUp, setCaughtUp] = useState(false);
  const rereading = !caughtUp && inbox.isFetching && inbox.dataUpdatedAt < opened;
  if (!rereading && !inbox.isPending && !caughtUp) setCaughtUp(true);
  const first = inbox.data?.pages[0];
  const applying = useSyncExternalStore(liveApplying.subscribe, liveApplying.get, liveApplying.get);
  const loading = setupPending || rereading || applying;
  return (
    <div className="page">
      <div className="page__head">
        <h1 id="home-title" className="page__title" tabIndex={-1}>{me.data ? t("home.greeting", { name: me.data.display_name }) : t("home.title")}</h1>
        {first?.as_of && <span className="muted num">{t("home.asOf", { time: fmtDateTime(first.as_of) })}</span>}
      </div>
      {loading ? <QueryState q={{ ...inbox, isPending: true }} layout="list">{() => null}</QueryState> : <section className="card panel" aria-labelledby="inbox-title">
        <h2 id="inbox-title" className="panel__title" tabIndex={-1}>{t("home.inbox.title")}</h2>
            {!first?.setup && first?.has_work && <div role="group" aria-label={t("home.lanes")} className="tabs">
              {FILTERS.filter((key) => first.available_filters.includes(key)).map((key) => {
                const count = first.counts[key];
                return <Button key={key} aria-pressed={filter === key} variant={filter === key ? "secondary" : "ghost"} onClick={() => setFilter(key)}>{t(count && !count.total_is_exact ? "home.inbox.filterCount.lower" : "home.inbox.filterCount", { filter: t(`home.inbox.filter.${key}`), count: count?.total ?? 0 })}</Button>;
              })}
            </div>}
        <QueryState q={inbox} layout="list">{(data) => {
          const pages = data.pages;
          const checklist = pages[0]?.setup;
          const rows = pages.flatMap((page) => page.items).filter((item) => !checklist || !item.kind.startsWith("setup_"));
          const head = pages[0];
          const unavailable = [...new Map(pages.flatMap((page) => page.unavailable).map((part) => [part.source, part])).values()];
          return <>
            {unavailable.map((part) => <Banner tone="danger" live="assertive" key={part.source} actions={<Button onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>{t("common.retry")}</Button>}>
              {t("home.inbox.unavailable", { part: t(SOURCE_TEXT[part.source] ?? "home.inbox.unknown") })} · {t("home.inbox.support", { reference: part.support_reference })}
            </Banner>)}
            {checklist && setup?.(checklist)}
            {!checklist && !head?.has_work && <EmptyState title={t("home.noWork.title")} reason={t("home.noWork.reason")} actions={rows.some((item) => item.kind === "account_security") ? undefined : <Link to="/account" className={buttonClass("primary")}>{t("shell.account")}</Link>} />}
            {rows.length > 0 ? <GroupedQueue items={rows} action={action} /> : !checklist && head?.has_work && <QuietQueue page={head} filter={filter} partial={unavailable.length > 0} />}
            {inbox.hasNextPage && <Button disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{t("home.inbox.more")}</Button>}
          </>;
        }}</QueryState>
      </section>}
    </div>
  );
}
