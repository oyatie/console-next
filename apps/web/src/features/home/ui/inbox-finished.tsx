// SPDX-License-Identifier: LicenseRef-Proprietary
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t, type MessageId } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { markNoticeRead } from "../api";
import { cursorPages } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { codeText } from "../../../lib/code-text";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";

const REFERENCE = "/api/v1/me/action-inbox/reference";
const DONE = "/api/v1/me/action-inbox/done";
type Notice = components["schemas"]["NotificationSummary"];
type Done = components["schemas"]["ActionInboxDoneItem"];
const DONE_KIND: Record<string, MessageId> = { hr_request: "home.part.requests", period_unlock: "home.part.unlocks", identifier_correction: "entityRecord.corrections.title" };

/** Only registered targets become links; a notice's own text never supplies a URL. */
function NoticeTarget({ link, children }: { link: Notice["link"]; children: string }) {
  const target = link as { kind?: string; id?: string; screen?: string };
  if (target.kind === "org_change" && target.id) return <Link to="/org/changes/$id" params={{ id: target.id }}>{children}</Link>;
  if (target.kind === "employee" && target.id) return <Link to="/people/$id" params={{ id: target.id }}>{children}</Link>;
  if (target.screen === "account") return <Link to="/account">{children}</Link>;
  if (target.screen === "settings/company-domain") return <Link to="/settings/company-domain">{children}</Link>;
  return <>{children}</>;
}

function NoticeRow({ notice }: { notice: Notice }) {
  const confirm = useCommand({
    run: () => markNoticeRead(notice.id),
    invalidates: [REFERENCE],
    announce: () => t("home.inbox.reference.confirmed"),
  });
  return <li>
    {notice.unread && <strong>{t("home.inbox.reference.unread")} · </strong>}<NoticeTarget link={notice.link}>{notice.text}</NoticeTarget> · <time className="muted num" dateTime={notice.created_at}>{fmtDateTime(notice.created_at)}</time>{" "}
    {notice.unread && <Button size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate(undefined)}>{t("home.inbox.reference.confirm")}</Button>}
  </li>;
}

/** The reference tab: notices addressed to me, newest first; confirming marks one read. */
export function ReferenceList() {
  const notices = useInfiniteQuery(cursorPages(REFERENCE, {}));
  return <QueryState q={notices} layout="list">{data => {
    const rows = data.pages.flatMap(page => page.items);
    if (!rows.length) return <EmptyState title={t("home.inbox.reference.empty")} reason={null} />;
    return <><ul className="list-plain">{rows.map(notice => <NoticeRow key={notice.id} notice={notice} />)}</ul>
      {notices.hasNextPage && <Button disabled={notices.isFetchingNextPage} onClick={() => void notices.fetchNextPage()}>{t("home.inbox.more")}</Button>}</>;
  }}</QueryState>;
}

function DoneTarget({ item }: { item: Done }) {
  const link = item.links[0];
  const text = t(DONE_KIND[item.kind] ?? "home.inbox.unknown");
  switch (link?.kind) {
    case "change_request": return <Link to="/people/requests" search={{ sel: link.id, status: "ALL" }}>{text}</Link>;
    case "period_lock": return <Link to="/people/period-locks" search={{ review: link.id }}>{text}</Link>;
    case "identifier_correction": return <Link to="/org/entities" search={{ correction: link.id }} hash="identifier-corrections">{text}</Link>;
    default: return <>{text}</>;
  }
}

/** The done tab: what I decided, newest first. */
export function DoneList() {
  const done = useInfiniteQuery(cursorPages(DONE, {}));
  return <QueryState q={done} layout="list">{data => {
    const rows = data.pages.flatMap(page => page.items);
    if (!rows.length) return <EmptyState title={t("home.inbox.done.empty")} reason={null} />;
    return <><ul className="list-plain">{rows.map(item => <li key={item.id}>
      <DoneTarget item={item} /> · {item.title} · {codeText(`home.inbox.outcome.${item.outcome}`, t("enum.unknown"))} · <time className="muted num" dateTime={item.completed_at}>{fmtDateTime(item.completed_at)}</time>
    </li>)}</ul>
      {done.hasNextPage && <Button disabled={done.isFetchingNextPage} onClick={() => void done.fetchNextPage()}>{t("home.inbox.more")}</Button>}</>;
  }}</QueryState>;
}
