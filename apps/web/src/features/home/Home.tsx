import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api";
import type { Checklist } from "@console/api/pending";
import { t, type MessageId } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { APPROVAL_ROLE, codeText, label } from "../../lib/labels";
import { cursorPages } from "../../lib/query";
import { QueryState } from "../../lib/react/query-state";
import { Button } from "../../ui/button/button";
import { buttonClass } from "../../ui/button/button-class";
import { DeadlineChip } from "../../ui/deadline-chip/deadline-chip";
import { EmptyState } from "../../ui/empty-state";
import { meQuery } from "./api";
import { GrantNotice } from "./ui/grant-notices";

type InboxItem = components["schemas"]["ActionInboxItem"];
const FILTERS = ["turn", "waiting", "scheduled", "deadlines", "failures"] as const;
type Filter = (typeof FILTERS)[number];
const KIND_TEXT: Record<string, MessageId> = {
  approval: "home.part.decide", org_change: "home.part.changes", org_change_waiting: "home.part.changes", org_change_scheduled: "home.part.changes", org_change_approve: "home.part.decide",
  org_change_apply: "home.part.changes", org_change_draft: "home.part.changes", org_change_rejected: "home.part.changes", org_change_settle: "home.part.changes",
  hr_exit: "home.part.exits", hr_exit_confirm: "home.part.exits", hr_exit_confirm_hq: "home.part.exits", hr_exit_settle: "home.part.exits",
  hr_lifecycle: "home.part.failedActions", lifecycle_apply_failed: "home.part.failedActions", hr_request: "home.part.requests",
  register_review: "home.review.register", identity_review: "home.review.identity", home_branch_review: "home.review.branch",
  contract_renewal: "people.lifecycle.action.CONTRACT_RENEWAL", insurance_filing: "home.part.insurance", period_unlock: "home.part.unlocks", grant_notice: "access.grant.title", account_security: "account.second.title",
};
const VERB_TEXT: Record<string, MessageId> = {
  org_change_approve: "home.decide.review", org_change_apply: "org.change.effectuate", org_change_draft: "home.mine.edit",
  org_change_rejected: "home.mine.rejection", org_change_settle: "home.mine.settle",
  hr_exit_confirm: "exit.action.confirm_exit", hr_exit_confirm_hq: "exit.action.confirm_exit_hq", hr_exit_settle: "exit.action.prepare_settlement",
  lifecycle_apply_failed: "home.failed.review", hr_lifecycle: "home.failed.review", contract_renewal: "people.lifecycle.action.CONTRACT_RENEWAL",
  insurance_filing: "statutory.open", identity_review: "home.failed.review", home_branch_review: "home.failed.review", register_review: "home.failed.review",
};
const WHY_TEXT: Record<string, MessageId> = {
  org_change_approve: "home.inbox.reason.approve", org_change_draft: "home.inbox.reason.draft",
  org_change_rejected: "home.inbox.reason.rejected", org_change_settle: "home.inbox.reason.settle",
  org_change_apply: "home.inbox.reason.apply", org_change_waiting: "home.inbox.reason.waiting", org_change_scheduled: "home.inbox.reason.scheduled",
  hr_exit_confirm: "home.inbox.reason.exitHr", hr_exit_confirm_hq: "home.inbox.reason.exitHq", hr_exit_settle: "home.inbox.reason.exitSettle",
  lifecycle_apply_failed: "home.inbox.reason.failed", hr_request: "home.inbox.reason.request",
  register_review: "home.inbox.reason.register", identity_review: "home.inbox.reason.identity", home_branch_review: "home.inbox.reason.branch",
  contract_renewal: "home.inbox.reason.contract", insurance_filing: "home.inbox.reason.insurance", period_unlock: "home.inbox.reason.unlock",
  grant_notice: "home.inbox.reason.grant", account_security: "home.inbox.reason.security",
};

/** Every surface reads this server queue; filters, ownership and deadlines stay with its sources. */
export function Home({ setup, account }: { setup?: (c: Checklist) => ReactNode; account?: ReactNode } = {}) {
  const [filter, setFilter] = useState<Filter>("turn");
  const me = useQuery(meQuery);
  const inbox = useInfiniteQuery(cursorPages("/api/v1/me/action-inbox", { filter }));
  return (
    <div className="page">
      <div className="page__head">
        <h1 id="home-title" className="page__title" tabIndex={-1}>{me.data ? t("home.greeting", { name: me.data.display_name }) : t("home.title")}</h1>
      </div>
      {account}
      <section className="card panel" aria-labelledby="inbox-title">
        <h2 id="inbox-title" className="panel__title" tabIndex={-1}>{t("home.inbox.title")}</h2>
        <div role="group" aria-label={t("home.lanes")} className="tabs">
          {FILTERS.map((key) => <Button key={key} aria-pressed={filter === key} variant={filter === key ? "secondary" : "ghost"} onClick={() => setFilter(key)}>{t(`home.inbox.filter.${key}`)}</Button>)}
        </div>
        <QueryState q={inbox}>{(data) => {
          const pages = data.pages;
          const checklist = pages[0]?.setup;
          const rows = pages.flatMap((page) => page.items).filter((item) => !checklist || !item.kind.startsWith("setup_"));
          return <>
            {checklist && setup?.(checklist)}
            {rows.length > 0 ? <ul className="list-plain">{rows.map((item) => <InboxRow key={item.id} item={item} />)}</ul> : !checklist && <EmptyState title={t("home.inbox.empty.title")} reason={t("home.inbox.empty.reason")} />}
            {inbox.hasNextPage && <Button disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{t("home.inbox.more")}</Button>}
          </>;
        }}</QueryState>
      </section>
    </div>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const kind = t(KIND_TEXT[item.kind] ?? "home.inbox.unknown");
  return (
    <li className="form">
      <div className="row">
        <div className="grow"><strong>{kind}</strong> · {item.kind === "hr_request" ? codeText(`requests.kind.${item.title}`, item.title) : item.title}</div>
        {item.days_remaining != null ? <DeadlineChip days={item.days_remaining} severity={item.dueTone === "danger" ? "over" : item.dueTone === "warn" ? "due" : "far"} /> : <span className="muted">{t("home.inbox.noDue")}</span>}
        <RecordAction item={item} />
      </div>
      <div className="muted">{[item.ref, item.site, item.who && item.kind.startsWith("org_change") ? label(APPROVAL_ROLE, item.who) : item.who].filter(Boolean).join(" · ")}</div>
      {item.due && <span className="muted num">{t("home.inbox.due", { at: fmtDateTime(item.due) })}</span>}
      <span className="muted">{t(WHY_TEXT[item.kind] ?? `home.inbox.why.${item.lane}`, { kind })}</span>
    </li>
  );
}

/** Only registered record kinds become links; source text cannot provide a URL. */
function RecordAction({ item }: { item: InboxItem }) {
  const link = item.links[0];
  if (!link) return null;
  const text = t(VERB_TEXT[item.kind] ?? "home.inbox.open");
  const className = buttonClass("primary");
  switch (link.kind) {
    case "org_change": return <Link to="/org/changes/$id" params={{ id: link.id }} className={className}>{text}</Link>;
    case "employee": return <Link to="/people/$id" params={{ id: link.id }} search={item.kind === "contract_renewal" ? { act: "CONTRACT_RENEWAL" } : {}} className={className}>{text}</Link>;
    case "change_request": return <Link to="/people/requests" search={{ sel: link.id }} className={className}>{text}</Link>;
    case "exit_case": return <Link to="/people/exits/$id" params={{ id: link.id }} search={{ act: item.kind === "hr_exit_confirm" ? "confirm_exit" : item.kind === "hr_exit_confirm_hq" ? "confirm_exit_hq" : "prepare_settlement" }} className={className}>{text}</Link>;
    case "period_lock": return <Link to="/people/period-locks" search={{ review: link.id }} className={className}>{text}</Link>;
    case "account": return <Link to="/account" className={className}>{t("account.second.add")}</Link>;
    case "access": return <GrantNotice id={link.id} role={item.title} />;
    case "statutory": return <Link to="/statutory" className={className}>{text}</Link>;
    default: return null;
  }
}
