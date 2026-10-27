// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";

type Page = components["schemas"]["ActionInboxResponse"];
const TILE = {
  register: { to: "/people/new", search: {} }, import: { to: "/people/import", search: {} },
  org: { to: "/org", search: {} }, invite: { to: "/people", search: { view: "accounts" } },
} as const;

export function QuietQueue({ page, filter, partial }: { page: Page; filter: string; partial: boolean }) {
  return <div>
    <EmptyState title={t(partial ? "home.empty.partial.title" : "home.inbox.empty.title")} reason={t(partial ? "home.empty.partial.reason" : "home.inbox.empty.reason")} />
    {filter === "turn" && <>
      {page.upcoming.length > 0 && <><h3>{t("home.next.title")}</h3><ul className="list-plain">{page.upcoming.map((item) => <li className="row" key={item.id}>
        <Link to="/org/changes/$id" params={{ id: item.links[0]!.id }}>{item.title}</Link>
        {item.days_remaining != null && <DeadlineChip days={item.days_remaining} severity="far" />}
      </li>)}</ul></>}
      {page.quick_starts.length > 0 && <nav aria-label={t("home.tiles.title")} className="row">{page.quick_starts.map((key) => <Link key={key} to={TILE[key].to} search={TILE[key].search} className={buttonClass()}>{t(`home.tiles.${key}`)}</Link>)}</nav>}
    </>}
  </div>;
}
