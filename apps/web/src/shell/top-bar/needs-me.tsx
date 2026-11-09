// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, useSyncExternalStore } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Inbox } from "lucide-react";
import { session } from "@console/api";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { cursorPages } from "../../lib/query";
import { inboxFilter } from "../../features/home/domain/inbox-filter";
import { QueryState } from "../../lib/react/query-state";
import { DeadlineChip } from "../../ui/deadline-chip/deadline-chip";
import { EmptyState } from "../../ui/empty-state";
import s from "./top-bar.module.css";

type InboxPage = components["schemas"]["ActionInboxResponse"];
type InboxItem = components["schemas"]["ActionInboxItem"];
const PREVIEW_LIMIT = 5;

function TaskRow({ item, onNavigate }: { item: InboxItem; onNavigate: () => void }) {
  const link = item.links[0];
  const targetId = link?.id.trim();
  const content = <><span className={s.name}>{item.title}</span>{item.days_remaining != null && <DeadlineChip days={item.days_remaining} severity={item.dueTone === "danger" ? "over" : item.dueTone === "warn" ? "due" : "far"} />}</>;
  const props = { className: s.taskLink, onClick: onNavigate, children: content };
  if (!link || !targetId) return <Link to="/inbox" {...props} />;
  switch (link.kind) {
    case "org_change": return <Link to="/org/changes/$id" params={{ id: targetId }} {...props} />;
    case "employee": return <Link to="/people/$id" params={{ id: targetId }} {...props} />;
    case "exit_case": return <Link to="/people/exits/$id" params={{ id: targetId }} {...props} />;
    case "change_request": return <Link to="/people/requests" search={{ sel: targetId }} {...props} />;
    case "period_lock": return <Link to="/people/period-locks" search={{ review: targetId }} {...props} />;
    case "support_session": return <Link to="/audit/support-access" search={{ review: targetId }} {...props} />;
    case "statutory": return <Link to="/statutory" search={{ event: targetId }} {...props} />;
    default: return <Link to="/inbox" {...props} />;
  }
}

function TaskItems({ items, onNavigate }: { items: InboxItem[]; onNavigate: () => void }) {
  if (!items.length) return <EmptyState title={t("home.inbox.empty.title")} reason={null} />;
  return <ul className={s.taskList}>{items.slice(0, PREVIEW_LIMIT).map(item => <li key={item.id}><TaskRow item={item} onNavigate={onNavigate} /></li>)}</ul>;
}

/** Header 'needs me' badge and popover task panel driven by `/api/v1/me/action-inbox` (`filter: "turn"`). */
export function NeedsMeMenu({ id, seed }: { id: string; seed?: InboxPage }) {
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const platform = !seed && !!claims?.platform;
  const { pathname, search } = useLocation();
  const [open, setOpen] = useState(false);
  const home = pathname === "/";
  const fullInbox = pathname === "/inbox";
  const shared = home || fullInbox;
  const filter = fullInbox ? inboxFilter(search.tab) : "turn";
  // Queue pages start their arrival read; keep the shared observer live after that answer.
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", home ? { filter, attention: "all" } : { filter }), enabled: query => !seed && !platform && (!shared || !!query.state.data), staleTime: Infinity, refetchOnMount: !shared && "always", notifyOnChangeProps: "all" });
  const separate = fullInbox && filter !== "turn";
  // Other inbox tabs supply counts, but the task panel always reads my turn when opened.
  const tasks = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter: "turn" }), enabled: !seed && !platform && separate && open, notifyOnChangeProps: "all" });
  if (platform) return null;
  const turn = (seed ?? (inbox.isSuccess ? inbox.data.pages[0] : undefined))?.counts?.turn;
  const count = turn?.total;
  const exact = turn?.total_is_exact;
  const label = count == null ? t(inbox.isPending ? "shell.needsMe.loading" : "shell.needsMe.unknown") : t(count > 0 ? exact ? "shell.needsMe.count" : "shell.needsMe.countMore" : "shell.needsMe", { count });
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button id={id} className={s.needsMe} aria-label={label}><Inbox size={16} aria-hidden /><span className={s.name}>{t("home.inbox.title")}</span>{!!count && <span className={s.badge} data-count>{exact ? count : `${count}+`}</span>}</Button>
      <Popover className={s.taskPop} placement="bottom end">
        <Dialog className={s.taskPanel} aria-label={t("shell.needsMe")}>
          {({ close }) => (<><div className={s.taskHead}><strong>{t("shell.needsMe")}</strong><Link to="/inbox" onClick={close}>{t("home.inbox.viewInbox")}</Link></div>{seed ? <TaskItems items={seed.items} onNavigate={close} /> : <QueryState q={separate ? tasks : inbox} layout="list" denied={<p role="status">{t("shell.needsMe.denied")}</p>}>{data => <TaskItems items={data.pages[0]?.items ?? []} onNavigate={close} />}</QueryState>}</>)}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
