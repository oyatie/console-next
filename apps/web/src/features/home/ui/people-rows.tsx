import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { EXIT_CASE_STATUS, label, labeled, LIFECYCLE_EVENT } from "../../../lib/labels";
import { QueueSection } from "./change-rows";

type Employee = components["schemas"]["Employee"];
type ExitCase = components["schemas"]["EmployeeExitCase"];
type ExitAction = ExitCase["next_actions"][number]["key"];
type Page = { items: Employee[]; total: number };

/** Exit cases waiting on a step this caller can take. `facts` renders the case's basis (the exits slice owns it). */
export function ExitQueue({ queue, more, facts }: { queue: { c: ExitCase; next: ExitAction }[]; more: boolean; facts: (c: ExitCase) => ReactNode }) {
  return (
    <QueueSection id="exits" title={t("home.exits.title", { count: queue.length })}>
      <ul className="list-plain">
        {queue.map(({ c, next }) => {
          const st = labeled(EXIT_CASE_STATUS, c.status);
          return (
            <li key={c.id} className="form">
              <div className="row">
                {/* The case page offers every step at once (reject included); the action link opens its step. */}
                <Link to="/people/exits/$id" params={{ id: c.id }} search={{}} className="grow">{c.employee_name}</Link>
                <span className="muted num">{t("exit.case.summary", { date: fmtDate(c.effective_exit_date) })}</span>
                <Chip tone={st.tone}>{st.label}</Chip>
                <Link to="/people/exits/$id" params={{ id: c.id }} search={{ act: next }} className="btn" aria-label={t("home.exits.open", { action: t(`exit.action.${next}`), name: c.employee_name })}>
                  {t(`exit.action.${next}`)}
                </Link>
              </div>
              {facts(c)}
            </li>
          );
        })}
      </ul>
      {more && <Link to="/people/exits" search={{ status: "open" }}>{t("home.exits.list")}</Link>}
    </QueueSection>
  );
}

/** Scheduled actions that could not take effect on their date and were not redone. */
export function FailedActions({ page }: { page: Page }) {
  const failed = page.items.filter((e) => e.failed_event);
  return (
    <QueueSection id="failed-actions" title={t("home.failed.title", { count: page.total })}>
      <span className="muted">{t("home.failed.next")}</span>
      <ul className="list-plain">
        {failed.map((e) => (
          <li key={e.id} className="row">
            <Link to="/people/$id" params={{ id: e.id }} className="grow">{e.name}</Link>
            <span className="muted num">{t("home.failed.what", { action: label(LIFECYCLE_EVENT, e.failed_event!.event_type), date: fmtDate(e.failed_event!.effective_date) })}</span>
            <Link to="/people/$id" params={{ id: e.id }} className="btn" aria-label={t("home.failed.reviewFor", { name: e.name })}>
              {t("home.failed.review")}
            </Link>
          </li>
        ))}
      </ul>
      {page.total > failed.length && <Link to="/people" search={{ review: "failed", status: "all" }}>{t("home.failed.all", { count: page.total })}</Link>}
    </QueueSection>
  );
}

/** Contracts ending within the renewal window (or already past while still employed). */
export function Renewals({ page }: { page: Page }) {
  return (
    <QueueSection id="renewals" title={t("home.renewals.title", { count: page.total })}>
      <ul className="list-plain">
        {page.items.map((e) => (
          <li key={e.id} className="row">
            <Link to="/people/$id" params={{ id: e.id }} className="grow">{e.name}</Link>
            <span className="muted num">{t("home.renewals.ends", { date: fmtDate(e.contract_end_date) })}</span>
            <Link to="/people/$id" params={{ id: e.id }} search={{ act: "CONTRACT_RENEWAL" }} className="btn" aria-label={t("home.renewals.renew", { name: e.name })}>
              {t("people.lifecycle.action.CONTRACT_RENEWAL")}
            </Link>
          </li>
        ))}
      </ul>
    </QueueSection>
  );
}

/** Records flagged for review. Each flag keeps its own server total and filter: one person can carry both. */
export function ReviewRecords({ people, kinds }: { people: Employee[]; kinds: { review: "identity" | "branch" | "register"; total: number }[] }) {
  return (
    <QueueSection id="review" title={t("home.review.title")}>
      <ul className="list-plain">
        {people.map((e) => (
          <li key={e.id} className="row">
            <Link to="/people/$id" params={{ id: e.id }} className="grow">{e.name}</Link>
            {e.register_review_required && <Chip tone="warn">{t("home.review.register")}</Chip>}
            {e.identity_review_required && <Chip tone="warn">{t("home.review.identity")}</Chip>}
            {e.home_branch_review_required && <Chip tone="warn">{t("home.review.branch")}</Chip>}
          </li>
        ))}
      </ul>
      <div className="row">
        {kinds.map((k) => (
          <Link key={k.review} to="/people" search={{ review: k.review }}>
            {t(k.review === "identity" ? "home.review.allIdentity" : k.review === "register" ? "home.review.allRegister" : "home.review.allBranch", { count: k.total })}
          </Link>
        ))}
      </div>
    </QueueSection>
  );
}
