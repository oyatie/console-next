// SPDX-License-Identifier: LicenseRef-Proprietary
import { Fragment, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { isMessageId, t, type MessageId } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { APPROVAL_ROLE, INSURER, LIFECYCLE_EVENT, codeText, label } from "../../../lib/labels";
import { reasonLabel } from "../../../lib/reason-codes";
import { domainText, periodText } from "../../../reference/periods/present";
import { OutcomeLink } from "../../../lib/react/outcome-link";
import { buttonClass } from "../../../ui/button/button-class";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { Table, type Column } from "../../../ui/table";
import { useCardLayout } from "../../../ui/long-table/use-card-layout";
import { DEADLINE_BUCKETS, deadlineBucket } from "../domain/deadline-bucket";
import { GrantNotice } from "./grant-notices";
import css from "./grouped-queue.module.css";

type InboxItem = components["schemas"]["ActionInboxItem"];
export type RowAction = (item: InboxItem) => ReactNode;
const KIND_TEXT: Record<string, MessageId> = {
  registration_check: "nts.title",
  identifier_correction_waiting: "entityRecord.corrections.title", identifier_correction_decide: "entityRecord.corrections.title", identifier_correction_apply: "entityRecord.corrections.title", identifier_correction_review: "entityRecord.corrections.title",
  support_access: "home.part.support", approval: "home.part.decide", org_change: "home.part.changes", org_change_waiting: "home.part.changes", org_change_scheduled: "home.part.changes", org_change_approve: "home.part.decide",
  org_change_apply: "home.part.changes", org_change_draft: "home.part.changes", org_change_rejected: "home.part.changes", org_change_settle: "home.part.changes",
  hr_exit: "home.part.exits", hr_exit_confirm: "home.part.exits", hr_exit_confirm_hq: "home.part.exits", hr_exit_settle: "home.part.exits",
  hr_lifecycle: "home.part.failedActions", lifecycle_apply_failed: "home.part.failedActions", hr_request: "home.part.requests",
  register_review: "home.review.register", identity_review: "home.review.identity", unplaced: "home.review.unplaced",
  contract_renewal: "people.lifecycle.action.CONTRACT_RENEWAL", insurance_filing: "home.part.insurance", period_unlock: "home.part.unlocks", grant_notice: "access.grant.title", account_security: "account.second.title",
};
const VERB_TEXT: Record<string, MessageId> = {
  registration_check: "nts.inbox.review",
  identifier_correction_waiting: "entityRecord.corrections.track", identifier_correction_decide: "home.inbox.correction.decide", identifier_correction_apply: "entityRecord.corrections.apply", identifier_correction_review: "entityRecord.corrections.review",
  org_change_approve: "home.decide.review", org_change_apply: "org.change.effectuate", org_change_draft: "home.mine.edit",
  org_change_rejected: "home.mine.rejection", org_change_settle: "home.mine.settle",
  hr_exit_confirm: "exit.action.confirm_exit", hr_exit_confirm_hq: "exit.action.confirm_exit_hq", hr_exit_settle: "exit.action.prepare_settlement",
  lifecycle_apply_failed: "home.failed.review", hr_lifecycle: "home.failed.review", contract_renewal: "people.lifecycle.action.CONTRACT_RENEWAL",
  insurance_filing: "statutory.open", identity_review: "home.failed.review", unplaced: "home.inbox.place", register_review: "home.inbox.enter",
  support_access: "supportAccess.review", period_unlock: "periodLocks.request.review", hr_request: "home.requests.review",
};
const REVIEW_FILTER: Record<string, string> = { unplaced: "unplaced", register_review: "register", identity_review: "identity", lifecycle_apply_failed: "failed" };
const REGISTER_FIELDS: Record<string, { label: MessageId; block: string }> = {
  birth: { label: "empCard.reg.item.birth", block: "s1" }, sex: { label: "empCard.reg.item.sex", block: "s1" }, address: { label: "empCard.reg.item.address", block: "s1" },
  job: { label: "empCard.reg.item.job", block: "s2" }, hire: { label: "empCard.reg.item.contract", block: "s3" }, contractEnd: { label: "empCard.reg.item.contract", block: "s3" }, career: { label: "empCard.reg.item.history", block: "s5" },
};

const RECORD_SOURCE: Record<string, MessageId> = {
  employee: "people.title", exit_case: "people.title", change_request: "home.part.requests",
  org_change: "home.part.changes", statutory: "statutory.title", account: "shell.account",
  access: "access.grant.title", period_lock: "home.part.unlocks", support_session: "home.part.support",
  identifier_correction: "entityRecord.corrections.title", registration_check: "nts.title",
};

/** One deadline presentation for Home and the inbox route; membership and cursor order stay server-owned. */
// shortcut: server-paged rows; use LongTable when adding cross-page selection.
export function GroupedQueue({ items, action }: { items: InboxItem[]; action?: RowAction }) {
  const surface = useRef<HTMLDivElement>(null);
  const compact = useCardLayout(surface, surface);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const normalized = items.map(item => item.kind === "home_branch_review" ? { ...item, kind: "unplaced" } : item).sort((a, b) => {
    if (!a.due || !b.due) return Number(!a.due) - Number(!b.due);
    return Date.parse(a.due) - Date.parse(b.due);
  });
  const folds = new Map<string, InboxItem[]>();
  for (const item of normalized) {
    const key = item.fold_key ? JSON.stringify([item.kind, item.fold_key, item.due ?? null]) : item.id;
    const siblings = folds.get(key) ?? [];
    siblings.push(item);
    folds.set(key, siblings);
  }
  const folded = new Map([...folds.values()].filter(rows => rows.length > 1).map(rows => [rows[0]!.id, rows]));
  const isFold = (item: InboxItem) => folded.get(item.id)?.[0] === item;
  const toggle = (id: string) => setExpanded(old => { const next = new Set(old); if (!next.delete(id)) next.add(id); return next; });
  const columns: Column<InboxItem>[] = [
    { header: t("home.inbox.column.task"), cell: item => <div id={item.kind === "registration_check" ? `nts-${item.id.split(":")[1]}` : undefined}>
      {isFold(item) ? <Button variant="ghost" aria-expanded={expanded.has(item.id)} onClick={() => toggle(item.id)}><ChevronRight size={16} aria-hidden data-expanded={expanded.has(item.id)} /><strong>{t("home.inbox.foldCount", { kind: t(KIND_TEXT[item.kind] ?? "home.inbox.unknown"), count: folded.get(item.id)!.length })}</strong></Button> : <strong>{t(KIND_TEXT[item.kind] ?? "home.inbox.unknown")}</strong>}
      {item.kind === "account_security" && <div className="muted">{t(item.context?.is_ops ? "account.second.whyOps" : "account.second.why")}</div>}
      {item.context?.register?.missing_fields.map(key => REGISTER_FIELDS[key] && <Chip key={key}>{t(REGISTER_FIELDS[key]!.label)}</Chip>)}
      {item.context?.drafter && <div className="muted">{t("home.decide.drafter", { name: item.context.drafter })}</div>}
      {item.context?.reason && <div>{item.context.reason}</div>}
      {item.context?.command_id && <OutcomeLink id={item.context.command_id} />}
    </div> },
    { header: t("home.inbox.column.subject"), cell: item => <Subject item={item} /> },
    { header: t("home.inbox.column.due"), cell: item => item.due ? <>
      {item.days_remaining != null && <DeadlineChip days={item.days_remaining} severity={item.dueTone === "danger" ? "over" : item.dueTone === "warn" ? "due" : "far"} />}
      <div className={compact ? "sr-only" : "muted num"}>{fmtDateTime(item.due)}</div>
      {item.kind === "org_change_apply" && item.days_remaining != null && item.days_remaining <= 0 && <div className="muted num">{t("home.due.since", { days: -item.days_remaining })}</div>}
    </> : null },
    { header: t("home.inbox.column.source"), cell: item => {
      if (item.kind === "unplaced") return <Link to="/people/unplaced">{t(KIND_TEXT[item.kind]!)}</Link>;
      if (REVIEW_FILTER[item.kind]) return <Link to="/people" search={{ review: REVIEW_FILTER[item.kind], ...(item.kind === "lifecycle_apply_failed" ? { status: "all" } : {}) }}>{t(KIND_TEXT[item.kind]!)}</Link>;
      return t(RECORD_SOURCE[item.links[0]?.kind ?? ""] ?? "home.inbox.unknown");
    } },
    { header: t("home.inbox.column.owner"), cell: item => item.who ? item.kind.startsWith("org_change") ? label(APPROVAL_ROLE, item.who) : item.who : null },
    { header: <span className="sr-only">{t("home.inbox.column.actions")}</span>, cell: item => {
      const control = isFold(item) ? null : recordAction(item, action);
      return control && (compact
        ? <PopoverButton trigger={<Ellipsis size={16} aria-hidden />} label={t("home.inbox.rowActions", { title: item.title })} title={item.title}>{() => control}</PopoverButton>
        : <div className={css.actions}>{control}</div>);
    } },
  ];
  const detail = (item: InboxItem) => isFold(item) && expanded.has(item.id) ? renderRows(folded.get(item.id)!.map(child => ({ ...child })), t(KIND_TEXT[item.kind] ?? "home.inbox.unknown")) : null;
  const renderRows = (rows: InboxItem[], name: string): ReactNode => compact
    ? <div role="table" aria-label={name} aria-colcount={columns.length}>
      <div role="rowgroup" className="sr-only"><div role="row">{columns.map((column, i) => <div role="columnheader" key={i}>{column.header}</div>)}</div></div>
      <div role="rowgroup">{rows.map(item => <Fragment key={item.id}>
        <div role="row" data-id={item.id} className={css.phoneRow}>
          {columns.map((column, i) => <div role="cell" aria-colindex={i + 1} key={i} className={i > 1 && i < 5 ? "muted t-xs" : undefined}>{column.cell(item)}</div>)}
        </div>
        {isFold(item) && expanded.has(item.id) && <div role="row"><div role="cell" aria-colspan={columns.length}>{detail(item)}</div></div>}
      </Fragment>)}</div>
    </div>
    : <Table detail={detail} label={name} rows={rows} rowId={item => item.id} columns={columns} />;
  return <div ref={surface} className={css.groups}>{DEADLINE_BUCKETS.map(bucket => {
    const rows = [...folds.values()].map(siblings => siblings[0]!).filter(item => deadlineBucket(item) === bucket);
    if (!rows.length) return null;
    return <section key={bucket} aria-label={t(`home.inbox.bucket.${bucket}`)}>
      <h3>{t(`home.inbox.bucket.${bucket}`)}</h3>
      {bucket === "undated" && Object.keys(REVIEW_FILTER).map(kind => {
        const reviews = normalized.filter(item => item.kind === kind);
        if (!reviews.length) return null;
        const count = Math.max(reviews.length, ...reviews.map(item => item.context?.review_count ?? 0));
        return <div key={kind} className={css.reviewCount}><strong>{t("home.inbox.reviewCount", { kind: t(KIND_TEXT[kind]!), count })}</strong>{kind === "unplaced" ? <Link to="/people/unplaced">{t("home.inbox.viewAll")}</Link> : <Link to="/people" search={{ review: REVIEW_FILTER[kind], ...(kind === "lifecycle_apply_failed" ? { status: "all" } : {}) }}>{t("home.inbox.viewAll")}</Link>}</div>;
      })}
      <div className={css.scroll}>{renderRows(rows, t(`home.inbox.bucket.${bucket}`))}</div>
    </section>;
  })}</div>;
}

function Subject({ item }: { item: InboxItem }) {
  const { unlock, insurance, lifecycle, request, correction } = item.context ?? {};
  const subject = unlock ? `${domainText(unlock.domain)} ${periodText(unlock)}` : request ? codeText(`requests.kind.${request.kind}`, t("requests.kind.OTHER")) : item.title;
  const facts = correction ? [`${t("entityRecord.corrections.state")}: ${t(`entityRecord.corrections.status.${correction.status}`)}`, item.who && `${t("entityRecord.corrections.requester")}: ${item.who}`] : unlock ? [unlock.requester, unlock.reason_entry || isMessageId(`reason.period_unlock.${unlock.reason_code}`) ? reasonLabel("period_unlock", unlock.reason_code, unlock.reason_entry ?? undefined) : t("enum.unknown")]
    : insurance ? [label(INSURER, insurance.insurer), codeText(`statutory.${insurance.kind}`, t("home.inbox.unknown")), fmtDate(insurance.effective_date)]
    : lifecycle ? [label(LIFECYCLE_EVENT, lifecycle.action_kind), fmtDate(lifecycle.effective_date)]
    : request ? [codeText(`requests.reason.${request.reason_code}`, /^[A-Z][A-Z0-9_]*$/.test(request.reason_code) ? t("enum.unknown") : request.reason_code)] : [];
  return <>{subject}<div className="muted">{[...facts, item.ref, item.site, item.context?.worksite_name && `${t("import.target.worksite_name")}: ${item.context.worksite_name}`].filter(Boolean).join(" · ")}</div></>;
}

/** Only registered record kinds become links; source text cannot provide a URL. */
function recordAction(item: InboxItem, action?: RowAction) {
  const link = item.links[0];
  if (!link) return null;
  const unlock = item.context?.unlock;
  const fields = (item.context?.register?.missing_fields ?? []).flatMap((key) => REGISTER_FIELDS[key] ? [REGISTER_FIELDS[key]!] : []);
  const text = item.kind === "register_review" ? [t("home.inbox.reason.register"), ...new Set(fields.map((field) => t(field.label))), t("home.inbox.enter")].join(" · ") : t(VERB_TEXT[item.kind] ?? "home.inbox.open", unlock ? { domain: domainText(unlock.domain), period: periodText(unlock) } : {});
  const className = buttonClass("secondary", { size: "sm" });
  const inline = action?.(item);
  switch (link.kind) {
    case "registration_check": {
      const [id, registrationId] = link.id.split("/");
      if (!id || !registrationId) return null;
      return <Link to="/org/entities/$id" params={{ id }} search={{ nts: registrationId }} className={className}>{text}</Link>;
    }
    case "identifier_correction": return <Link to="/org/entities" search={{ correction: link.id }} hash="identifier-corrections" className={className}>{text}</Link>;
    case "org_change": return <>{inline}<Link to="/org/changes/$id" params={{ id: link.id }} className={buttonClass(inline ? "ghost" : "secondary", { size: "sm" })}>{text}</Link></>;
    case "employee": return <Link to="/people/$id" params={{ id: link.id }} search={item.kind === "contract_renewal" ? { act: "CONTRACT_RENEWAL" } : item.kind === "unplaced" ? { act: "TRANSFER" } : {}} hash={item.kind === "register_review" ? fields[0]?.block ?? "register" : undefined} className={className}>{text}</Link>;
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
