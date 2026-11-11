// SPDX-License-Identifier: LicenseRef-Proprietary
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t, type MessageId } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { cursorPages } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { codeText } from "../../../lib/code-text";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";

const DONE = "/api/v1/me/action-inbox/done";
type Done = components["schemas"]["ActionInboxDoneItem"];
const DONE_KIND: Record<string, MessageId> = { hr_request: "home.part.requests", period_unlock: "home.part.unlocks", identifier_correction: "entityRecord.corrections.title" };

function DoneTarget({ item }: { item: Done }) {
  const link = item.links[0];
  const text = t(DONE_KIND[item.kind] ?? "home.inbox.unknown");
  switch (link?.kind) {
    case "change_request": return <Link to="/people/requests" search={{ sel: link.id }}>{text}</Link>;
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
    return <><ul className="list-plain">{rows.map(item => <li className="row" key={item.id}>
      <span><DoneTarget item={item} /> · {item.title} · {codeText(`home.inbox.outcome.${item.outcome}`, t("enum.unknown"))}
        <span className="muted num"> · <time dateTime={item.completed_at}>{fmtDateTime(item.completed_at)}</time></span></span>
    </li>)}</ul>
      {done.hasNextPage && <Button disabled={done.isFetchingNextPage} onClick={() => void done.fetchNextPage()}>{t("home.inbox.more")}</Button>}</>;
  }}</QueryState>;
}
