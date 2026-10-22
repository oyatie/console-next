// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Pager } from "../../../ui/pager";
import { QueueSection } from "./change-rows";

/** Committed account-based decisions remain visible until the account has a person binding. */
export function IdentityDecisionReviews({ page, onPage }: { page: components["schemas"]["UserPage"]; onPage: (offset: number) => void }) {
  return (
    <QueueSection id="identity-decisions" title={t("home.identityDecisions.title", { count: page.total })}>
      <p>{t("home.identityDecisions.reason")}</p>
      <ul className="list-plain">{page.items.map((u) => (
        <li key={u.id} className="row">
          <Link className="grow" to="/people" search={{ view: "accounts", sel: u.id }}>{t("home.identityDecisions.open", { name: u.display_name })}</Link>
        </li>
      ))}</ul>
      <Pager offset={page.offset} limit={page.limit} total={page.total} onPage={onPage} />
    </QueueSection>
  );
}
