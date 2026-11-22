// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { QueryState } from "../../../lib/react/query-state";
import { buttonClass } from "../../../ui/button/button-class";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { CompanyMappings } from "./company-mappings";
import { UnplacedFeedback, UnplacedPanes, UnplacedTabsRow } from "./unplaced-panes";
import { useUnplacedWorkspace } from "./use-unplaced-workspace";
import s from "./unplaced.module.css";

const UnplacedConsole = lazy(() => chunk(import("./unplaced-console")).then((m) => ({ default: m.UnplacedConsole })));

/**
 * The unplaced screen (spec E8): people with no workplace or department, per company, grouped by the value their import gave;
 * pick people, then a place (a suggestion by number key, a search inside the company, or the workplace itself).
 */
export function UnplacedPage() {
  return (
    <ExperienceSwitch baseline={() => <UnplacedBaseline />}>
      {() => (
        <Suspense fallback={<ReadSkeleton layout="list" />}>
          <UnplacedConsole />
        </Suspense>
      )}
    </ExperienceSwitch>
  );
}

function UnplacedBaseline() {
  const ws = useUnplacedWorkspace();
  const { queue, pageRead, setup, all, placedCount, parts } = ws;

  return (
    <div className={s.page}>
      <PageHead
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("unplaced.crumbTodo")} />}
        title={t("unplaced.title")}
        meta={<PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "unplaced.phaseSetup" : "unplaced.phaseOp")}</PhaseLine>}
        tools={
          <>
            <span className={s.sum} aria-busy={queue.isPending}>{queue.isSuccess ? <>{t("unplaced.sum", { left: queue.data.count, parts, done: placedCount })}<br />{t("unplaced.reasons", { workplaces: all.filter((p) => p.reason !== "unit_unknown").length, departments: all.filter((p) => p.reason === "unit_unknown").length })}</> : "—"}</span>
            <Link to="/people" search={{}} className={buttonClass("ghost")}>{t("unplaced.back")}</Link>
          </>
        }
      />
      <QueryState q={pageRead} layout="list">
        {() => (
          <>
            <UnplacedTabsRow ws={ws} tabsClassName={s.tabs} countClassName={s.count} />
            <UnplacedPanes
              ws={ws}
              panesClassName={s.panes}
              footer={
                <>
                  <div className={s.mappings}><CompanyMappings /></div>
                  <UnplacedFeedback ws={ws} />
                </>
              }
            />
          </>
        )}
      </QueryState>
    </div>
  );
}
