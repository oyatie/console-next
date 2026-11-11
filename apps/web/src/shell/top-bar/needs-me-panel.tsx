// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { QueryState } from "../../lib/react/query-state";
import type { ReadState } from "../../lib/react/query-view";
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

export function NeedsMePanel({ seed, inbox, onNavigate }: { seed?: InboxPage; inbox: ReadState<{ pages: InboxPage[] }>; onNavigate: () => void }) {
  return <><div className={s.taskHead}><strong>{t("shell.needsMe")}</strong><Link to="/inbox" onClick={onNavigate}>{t("home.inbox.viewInbox")}</Link></div>{seed ? <TaskItems items={seed.items} onNavigate={onNavigate} /> : <QueryState q={inbox} layout="list" denied={<p role="status">{t("shell.needsMe.denied")}</p>}>{data => <TaskItems items={data.pages[0]?.items ?? []} onNavigate={onNavigate} />}</QueryState>}</>;
}
