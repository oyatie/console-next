// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Inbox } from "lucide-react";
import { session } from "@console/api";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { cursorPages } from "../../lib/query";
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
  if (!link || !targetId) return <Link to="/inbox" className={s.taskLink} onClick={onNavigate}>{content}</Link>;
  switch (link.kind) {
    case "org_change": return <Link to="/org/changes/$id" params={{ id: targetId }} className={s.taskLink} onClick={onNavigate}>{content}</Link>;
    case "employee": return <Link to="/people/$id" params={{ id: targetId }} className={s.taskLink} onClick={onNavigate}>{content}</Link>;
    case "exit_case": return <Link to="/people/exits/$id" params={{ id: targetId }} className={s.taskLink} onClick={onNavigate}>{content}</Link>;
    case "change_request": return <Link to="/people/requests" search={{ sel: targetId }} className={s.taskLink} onClick={onNavigate}>{content}</Link>;
    case "period_lock": return <Link to="/people/period-locks" search={{ review: targetId }} className={s.taskLink} onClick={onNavigate}>{content}</Link>;
    case "support_session": return <Link to="/audit/support-access" search={{ review: targetId }} className={s.taskLink} onClick={onNavigate}>{content}</Link>;
    case "statutory": return <Link to="/statutory" search={{ event: targetId }} className={s.taskLink} onClick={onNavigate}>{content}</Link>;
    default: return <Link to="/inbox" className={s.taskLink} onClick={onNavigate}>{content}</Link>;
  }
}

function TaskItems({ items, onNavigate }: { items: InboxItem[]; onNavigate: () => void }) {
  if (!items.length) return <EmptyState title={t("home.inbox.empty.title")} reason={null} />;
  return <ul className={s.taskList}>{items.slice(0, PREVIEW_LIMIT).map(item => <li key={item.id}><TaskRow item={item} onNavigate={onNavigate} /></li>)}</ul>;
}

/** Header 'needs me' badge and popover task panel driven by `/api/v1/me/action-inbox` (`filter: "turn"`). */
export function NeedsMeMenu({ id, seed }: { id: string; seed?: InboxPage }) {
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const platform = Boolean(!seed && claims?.platform);
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter: "turn" }), placeholderData: keepPreviousData, enabled: !seed && !platform });
  if (platform) return null;
  const page = seed ?? inbox.data?.pages[0];
  const turn = page?.counts?.["turn"];
  const count = turn?.total ?? page?.items.length ?? 0;
  const exact = turn?.total_is_exact ?? page?.total_is_exact ?? true;
  const label = count > 0 ? t(exact ? "shell.needsMe.count" : "shell.needsMe.countMore", { count }) : t("shell.needsMe");
  return (
    <DialogTrigger>
      <Button id={id} className={s.needsMe} aria-label={label}><Inbox size={16} aria-hidden /><span className={s.name}>{t("home.inbox.title")}</span>{count > 0 && <span className={s.badge} data-count>{exact ? count : `${count}+`}</span>}</Button>
      <Popover className={s.taskPop} placement="bottom end">
        <Dialog className={s.taskPanel} aria-label={t("shell.needsMe")}>
          {({ close }) => (<><div className={s.taskHead}><strong>{t("shell.needsMe")}</strong><Link to="/inbox" onClick={close}>{t("home.inbox.viewInbox")}</Link></div>{seed ? <TaskItems items={seed.items} onNavigate={close} /> : <QueryState q={inbox} layout="list">{data => <TaskItems items={data.pages[0]?.items ?? []} onNavigate={close} />}</QueryState>}</>)}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
