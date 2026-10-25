import { useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api";
import type { Checklist } from "@console/api/pending";
import { isMessageId, t, type MessageId } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { APPROVAL_ROLE, INSURER, LIFECYCLE_EVENT, codeText, label } from "../../lib/labels";
import { reasonLabel } from "../../lib/reason-codes";
import { domainText, periodText } from "../../reference/periods/present";
import { cursorPages } from "../../lib/query";
import { QueryState } from "../../lib/react/query-state";
import { Button } from "../../ui/button/button";
import { buttonClass } from "../../ui/button/button-class";
import { DeadlineChip } from "../../ui/deadline-chip/deadline-chip";
import { EmptyState } from "../../ui/empty-state";
import { Banner } from "../../ui/banner/banner";
import { QuietQueue } from "./ui/quiet-queue";
import { OutcomeLink } from "../../lib/react/outcome-link";
import { meQuery } from "./api";
import { GrantNotice } from "./ui/grant-notices";

type InboxItem = components["schemas"]["ActionInboxItem"];
type RowAction = (item: InboxItem) => ReactNode;
const FILTERS = ["turn", "waiting", "scheduled", "deadlines", "failures"] as const;
type Filter = (typeof FILTERS)[number];
const KIND_TEXT: Record<string, MessageId> = {
  registration_check: "nts.title",
  identifier_correction_waiting: "entityRecord.corrections.title", identifier_correction_decide: "entityRecord.corrections.title", identifier_correction_apply: "entityRecord.corrections.title", identifier_correction_review: "entityRecord.corrections.title",
  support_access: "home.part.support", approval: "home.part.decide", org_change: "home.part.changes", org_change_waiting: "home.part.changes", org_change_scheduled: "home.part.changes", org_change_approve: "home.part.decide",
  org_change_apply: "home.part.changes", org_change_draft: "home.part.changes", org_change_rejected: "home.part.changes", org_change_settle: "home.part.changes",
  hr_exit: "home.part.exits", hr_exit_confirm: "home.part.exits", hr_exit_confirm_hq: "home.part.exits", hr_exit_settle: "home.part.exits",
  hr_lifecycle: "home.part.failedActions", lifecycle_apply_failed: "home.part.failedActions", hr_request: "home.part.requests",
  register_review: "home.review.register", identity_review: "home.review.identity", home_branch_review: "home.review.branch",
  contract_renewal: "people.lifecycle.action.CONTRACT_RENEWAL", insurance_filing: "home.part.insurance", period_unlock: "home.part.unlocks", grant_notice: "access.grant.title", account_security: "account.second.title",
};
const VERB_TEXT: Record<string, MessageId> = {
  registration_check: "nts.inbox.review",
  identifier_correction_waiting: "entityRecord.corrections.track", identifier_correction_decide: "home.inbox.correction.decide", identifier_correction_apply: "entityRecord.corrections.apply", identifier_correction_review: "entityRecord.corrections.review",
  org_change_approve: "home.decide.review", org_change_apply: "org.change.effectuate", org_change_draft: "home.mine.edit",
  org_change_rejected: "home.mine.rejection", org_change_settle: "home.mine.settle",
  hr_exit_confirm: "exit.action.confirm_exit", hr_exit_confirm_hq: "exit.action.confirm_exit_hq", hr_exit_settle: "exit.action.prepare_settlement",
  lifecycle_apply_failed: "home.failed.review", hr_lifecycle: "home.failed.review", contract_renewal: "people.lifecycle.action.CONTRACT_RENEWAL",
  insurance_filing: "statutory.open", identity_review: "home.failed.review", home_branch_review: "home.failed.review", register_review: "home.failed.review",
  support_access: "supportAccess.review", period_unlock: "periodLocks.request.review", hr_request: "home.requests.review",
};
const WHY_TEXT: Record<string, MessageId> = {
  registration_check: "nts.inbox.reason",
  org_change_approve: "home.inbox.reason.approve", org_change_draft: "home.inbox.reason.draft",
  org_change_rejected: "home.inbox.reason.rejected", org_change_settle: "home.inbox.reason.settle",
  org_change_apply: "home.inbox.reason.apply", org_change_waiting: "home.inbox.reason.waiting", org_change_scheduled: "home.inbox.reason.scheduled",
  hr_exit_confirm: "home.inbox.reason.exitHr", hr_exit_confirm_hq: "home.inbox.reason.exitHq", hr_exit_settle: "home.inbox.reason.exitSettle",
  lifecycle_apply_failed: "home.inbox.reason.failed", hr_request: "home.inbox.reason.request",
  register_review: "home.inbox.reason.register", identity_review: "home.inbox.reason.identity", home_branch_review: "home.inbox.reason.branch",
  contract_renewal: "home.inbox.reason.contract", insurance_filing: "home.inbox.reason.insurance", period_unlock: "home.inbox.reason.unlock",
  grant_notice: "home.inbox.reason.grant", account_security: "home.inbox.reason.security",
};

const SOURCE_TEXT: Record<string, MessageId> = {
  registration_checks: "nts.title",
  entity_corrections: "entityRecord.corrections.title",
  support_access: "home.part.support", workflow: "home.part.decide", dispatch: "home.inbox.source.dispatch", support: "home.inbox.source.support", work_order: "home.inbox.source.workOrder", payroll: "accessCodes.domain.pay", governance: "home.inbox.source.governance",
  org_change: "home.part.changes", hr_exit: "home.part.exits", hr_lifecycle: "home.part.failedActions", hr_requests: "home.part.requests", hr_register: "home.review.register", hr_insurance: "home.part.insurance", hr_identity: "home.review.identity", hr_branch: "home.review.branch", hr_contract: "people.lifecycle.action.CONTRACT_RENEWAL", period_unlock: "home.part.unlocks", setup: "setup.title", grant_notice: "access.grant.title",
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
  const loading = setupPending || rereading;
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
            {rows.length > 0 ? <ul className="list-plain">{rows.map((item) => <InboxRow key={item.id} item={item} action={action} />)}</ul> : !checklist && head?.has_work && <QuietQueue page={head} filter={filter} partial={unavailable.length > 0} />}
            {inbox.hasNextPage && <Button disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{t("home.inbox.more")}</Button>}
          </>;
        }}</QueryState>
      </section>}
    </div>
  );
}

function InboxRow({ item, action }: { item: InboxItem; action?: RowAction }) {
  const kind = t(KIND_TEXT[item.kind] ?? "home.inbox.unknown");
  const { unlock, insurance, lifecycle, request, correction } = item.context ?? {};
  const subject = unlock ? `${domainText(unlock.domain)} ${periodText(unlock)}` : request ? codeText(`requests.kind.${request.kind}`, t("requests.kind.OTHER")) : item.title;
  const facts = correction ? [`${t("entityRecord.corrections.state")}: ${t(`entityRecord.corrections.status.${correction.status}`)}`] : unlock ? [unlock.requester, unlock.reason_entry || isMessageId(`reason.period_unlock.${unlock.reason_code}`) ? reasonLabel("period_unlock", unlock.reason_code, unlock.reason_entry ?? undefined) : t("enum.unknown")]
    : insurance ? [label(INSURER, insurance.insurer), codeText(`statutory.${insurance.kind}`, t("home.inbox.unknown")), fmtDate(insurance.effective_date)]
    : lifecycle ? [label(LIFECYCLE_EVENT, lifecycle.action_kind), fmtDate(lifecycle.effective_date)]
    : request ? [codeText(`requests.reason.${request.reason_code}`, /^[A-Z][A-Z0-9_]*$/.test(request.reason_code) ? t("enum.unknown") : request.reason_code)] : [];
  return (
    <li className="form" id={item.kind === "registration_check" ? `nts-${item.id.split(":")[1]}` : undefined}>
      <div className="row">
        <div className="grow"><strong>{kind}</strong> · {subject}</div>
        {item.days_remaining != null ? <DeadlineChip days={item.days_remaining} severity={item.dueTone === "danger" ? "over" : item.dueTone === "warn" ? "due" : "far"} /> : <span className="muted">{t("home.inbox.noDue")}</span>}
        <RecordAction item={item} action={action} />
      </div>
      <div className="muted">{[...facts, item.ref, item.site, item.who && item.kind.startsWith("org_change") ? label(APPROVAL_ROLE, item.who) : correction && item.who ? `${t("entityRecord.corrections.requester")}: ${item.who}` : item.who].filter(Boolean).join(" · ")}</div>
      {item.due && <span className="muted num">{t("home.inbox.due", { at: fmtDateTime(item.due) })}</span>}
      {item.context?.drafter && <span className="muted">{t("home.decide.drafter", { name: item.context.drafter })}</span>}
      {item.context?.reason && <span>{item.context.reason}</span>}
      {item.kind === "org_change_apply" && item.days_remaining != null && item.days_remaining <= 0 && <span className="muted num">{t("home.due.since", { days: -item.days_remaining })}</span>}
      {item.context?.command_id && <OutcomeLink id={item.context.command_id} />}
      <span className="muted">{item.kind === "account_security" ? t(item.context?.is_ops ? "account.second.whyOps" : "account.second.why") : t(WHY_TEXT[item.kind] ?? `home.inbox.why.${item.lane}`, { kind })}</span>
    </li>
  );
}

/** Only registered record kinds become links; source text cannot provide a URL. */
function RecordAction({ item, action }: { item: InboxItem; action?: RowAction }) {
  const link = item.links[0];
  if (!link) return null;
  const unlock = item.context?.unlock;
  const text = t(VERB_TEXT[item.kind] ?? "home.inbox.open", unlock ? { domain: domainText(unlock.domain), period: periodText(unlock) } : {});
  const className = buttonClass("primary");
  const inline = action?.(item);
  switch (link.kind) {
    case "registration_check": {
      const [id, registrationId] = link.id.split("/");
      if (!id || !registrationId) return null;
      return <Link to="/org/entities/$id" params={{ id }} search={{ nts: registrationId }} className={className}>{text}</Link>;
    }
    case "identifier_correction": return <Link to="/org/entities" search={{ correction: link.id }} hash="identifier-corrections" className={className}>{text}</Link>;
    case "org_change": return <>{inline}<Link to="/org/changes/$id" params={{ id: link.id }} className={buttonClass(inline ? "ghost" : "primary")}>{text}</Link></>;
    case "employee": return <><Link to="/people/$id" params={{ id: link.id }} search={item.kind === "contract_renewal" ? { act: "CONTRACT_RENEWAL" } : {}} className={className}>{text}</Link>{item.kind === "identity_review" || item.kind === "home_branch_review" || item.kind === "register_review" || item.kind === "lifecycle_apply_failed" ? <Link to="/people" search={{ review: item.kind === "identity_review" ? "identity" : item.kind === "home_branch_review" ? "branch" : item.kind === "register_review" ? "register" : "failed", ...(item.kind === "lifecycle_apply_failed" ? { status: "all" } : {}) }}>{t("home.inbox.viewAll")}</Link> : null}</>;
    case "support_session": return <Link to="/audit/support-access" search={{ review: link.id }} className={className}>{text}</Link>;
    case "change_request": return <Link to="/people/requests" search={{ sel: link.id }} className={className}>{text}</Link>;
    case "exit_case": return <Link to="/people/exits/$id" params={{ id: link.id }} search={{ act: item.kind === "hr_exit_confirm" ? "confirm_exit" : item.kind === "hr_exit_confirm_hq" ? "confirm_exit_hq" : "prepare_settlement" }} className={className}>{text}</Link>;
    case "period_lock": return <Link to="/people/period-locks" search={{ review: link.id }} className={className}>{text}</Link>;
    case "account": return <>{inline}<Link to="/account" className={buttonClass("ghost")}>{t("shell.account")}</Link></>;
    case "access": return <GrantNotice id={link.id} role={item.title} entries={item.context?.grants ?? []} />;
    case "statutory": return <Link to="/statutory" search={{ event: link.id }} className={className}>{text}</Link>;
    default: return null;
  }
}
