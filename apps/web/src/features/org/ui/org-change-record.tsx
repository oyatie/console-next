import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { useCan } from "../../../reference/authz/ui/use-can";
import { GateRail } from "../../../ui/gate-rail";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { changeQuery } from "../api";
import { type Names } from "../present";
import { ChangeChain } from "./change-chain";
import { ChangeHead } from "./change-head";
import { ChangePreflight } from "./change-preflight";
import { ChangeSettlement } from "./change-settlement";
import { OrgChangeConsole } from "./org-change-console";
import { OrgChangeHistoryTimeline, OrgChangeNextStep, OrgChangeNotices, OrgChangeReceiptDock, ProposalBody } from "./org-change-parts";
import { useChangeNames } from "./use-change-names";
import { useOrgChangeRecord } from "./use-org-change-record";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
const route = getRouteApi("/app/org/changes/$id");

/** One org change: what it changes, where it stands, and the next step it asks of this viewer. */
export function OrgChange() {
  const { id } = route.useParams();
  // Opened from the list or Home, the record re-reads at once: the row just seen may be newer than the cache.
  const change = useQuery({ ...changeQuery(id), refetchOnMount: "always" });
  const can = useCan();
  const n = useChangeNames();
  // Until that re-read lands, a cached record stays off screen: a newer one (rejected meanwhile, say) would
  // otherwise land a moment later and move every action on the page under a pointer already on one.
  const [opened] = useState(Date.now);
  const settling = n.pending || (change.isFetching && change.dataUpdatedAt < opened);
  const q = settling ? { ...change, isPending: true } : change;
  return (
    <ExperienceSwitch
      baseline={() => (
        <div className="page">
          <QueryState q={q} keepOnLoss back={{ to: "/org/changes", label: t("structure.tab.changes") }} layout="record">
            {(d) => <Record key={d.id} d={d} n={n} can={can} refetch={change.refetch} />}
          </QueryState>
        </div>
      )}
    >
      {() => <OrgChangeConsole q={q} n={n} can={can} refetch={change.refetch} />}
    </ExperienceSwitch>
  );
}

function Record({ d, n, can, refetch }: { d: Detail; n: Names; can: ReturnType<typeof useCan>; refetch: () => Promise<{ data?: Detail }> }) {
  const st = useOrgChangeRecord(d, n, can);
  const rail = st.rail!;
  return (
    <>
      <ChangeHead d={d} title={st.title} today={st.today} />
      {st.note && <OrgChangeReceiptDock code={d.code} receipt={st.note} />}
      <OrgChangeNotices
        unsentCount={st.unsent && st.editable && st.report && st.report.blockers.length > 0 ? st.report.blockers.length : 0}
        leftDraftAt={st.leftDraft ? d.updatedAt : null}
      />
      <GateRail steps={rail.steps} current={rail.current} failed={rail.failed} />
      <div className={css.cols}>
        <div className={`page__sub ${css.main}`}>
          <section className="card panel" aria-labelledby="proposal">
            <h2 id="proposal" className="panel__title">{t("orgChange.proposal")}</h2>
            <ProposalBody d={d} n={n} headcount={st.report?.headcount ?? d.headcount} />
          </section>
          <OrgChangeNextStep d={d} st={st} n={n} refetch={refetch} />
          {st.report && (
            <ChangePreflight d={d} report={st.report} checking={st.preflight.isPending} onRerun={() => st.preflight.mutate(undefined)} onEdit={() => st.setEditing(true)} />
          )}
          <CommandError error={st.preflight.error} />
          {d.approvalSteps.length > 0 && <ChangeChain d={d} />}
          {d.settlementItems.length > 0 && <ChangeSettlement d={d} refetch={refetch} onNote={st.show} />}
        </div>
        <aside className="card panel" aria-labelledby="history">
          <h2 id="history" className="panel__title">{t("orgChange.history")}</h2>
          {st.place && <Link to="/org" search={st.place}>{t("orgChange.openUnit")}</Link>}
          <OrgChangeHistoryTimeline events={d.events} />
        </aside>
      </div>
    </>
  );
}
