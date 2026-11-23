// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { ReadState } from "../../../lib/react/query-view";
import { EmptyState } from "../../../ui/empty-state";
import { PageHead } from "../../../ui/page-head/page-head";
import type { Floorplan } from "../../../ui/page/floorplan";
import { PatternShell, type PatternHead } from "../../../ui/patterns/pattern-shell";
import type { PatternId } from "../../../ui/patterns/patterns";
import type { ReadLayout } from "../../../ui/skeleton/skeleton";

/**
 * A self-service page for a signed-in account with no employee record. The page keeps its frame and head and says
 * why it has nothing to show. `q` is the users/me read that showed the account unlinked.
 */
export function SelfServiceUnlinked({
  q,
  head,
  pattern,
  floorplan,
  queryLayout,
}: {
  q: ReadState;
  head: Pick<PatternHead, "title" | "titleId" | "crumbs">;
  pattern: PatternId;
  floorplan: Floorplan;
  queryLayout: ReadLayout;
}) {
  const empty = <EmptyState title={t("account.status.unlinked")} reason={t("me.desk.profile.unlinked")} />;
  return (
    <PatternShell
      pattern={pattern}
      floorplan={floorplan}
      q={q}
      head={head}
      queryLayout={queryLayout}
      phoneHeadAware
      baseline={() => (
        <main className="page" data-floorplan={floorplan}>
          <PageHead title={head.title} crumbs={head.crumbs} />
          {empty}
        </main>
      )}
    >
      {() => empty}
    </PatternShell>
  );
}
