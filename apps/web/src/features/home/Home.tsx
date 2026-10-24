import { useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, session, unwrap, type components, type paths } from "@console/api";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Link } from "@tanstack/react-router";
import { focusSoon } from "../../lib/react/announce";
import { useCommand } from "../../lib/react/command";
import { Dialog } from "../../ui/dialog";
import { actor, APPROVAL_ROLE, label, ORG_CHANGE_KIND } from "../../lib/labels";
import { Chip } from "../../ui/chip";
import { CommandError } from "../../lib/react/command-error";
import { QueryState } from "../../lib/react/query-state";
import { changeQuery, EffectuateConsequence } from "../org/OrgChange";
import { changeSubject } from "../../reference/org/present";
import { authzQuery, granted, myAccessQuery } from "../../reference/authz/api";
import { todayKst } from "../../lib/pure/today";
import { branchesQuery, ORG_READS, unitsQuery } from "../../reference/org/api";
import { changesByStatusQuery, myChangesQuery } from "../org/api";
import { CONTRACT_SOON_DAYS } from "../people/Employee";
import { CaseFacts } from "../people/ExitCase";
import { exitCasesQuery, openRequestsQuery } from "../people/api";
import { usableActions } from "../people/domain/exits";
import { get } from "../../lib/query";
import { hqNeedsSomeoneElse } from "../../reference/settings/domain/policy";
import { usePolicyRouted } from "../../reference/settings/ui/use-policy-routed";
import { hasWork, meQuery, readState } from "./api";
import { coverage } from "./domain/coverage";
import { addDays, changeLanes, daysUntil, LANES, VIEWS, type Lane, type View } from "./domain/lanes";
import { ChangeLine, MineList, QueueSection, ScheduledList, WaitingList } from "./ui/change-rows";
import { CoverageNotice, type Part } from "./ui/coverage-notice";
import { NoWork } from "./ui/no-work";
import { RequestQueue } from "./ui/request-queue";
import { ExitQueue, FailedActions, Renewals, ReviewRecords } from "./ui/people-rows";
import { QueueEmpty, type Tile } from "./ui/queue-empty";
import { buttonClass } from "../../ui/button/button-class";
import { filingsQuery } from "../../reference/statutory/api";
import { inForceLocksQuery } from "../../reference/periods/api";
import { toDecide } from "../../reference/periods/domain/request";
import { activeSupportQuery } from "../../reference/support-access/api";
import { UnlockQueue } from "./ui/unlock-queue";
import { GrantNotices } from "./ui/grant-notices";
type Summary = components["schemas"]["OrgChangeSummary"];
type Employee = components["schemas"]["Employee"];
type EmployeeQuery = NonNullable<paths["/api/v1/employees"]["get"]["parameters"]["query"]>;

/** Employees still employed: exited records need no review or renewal. */
const CURRENT = ["ACTIVE", "ON_LEAVE", "UNKNOWN"] as const;
const LIST = 8;
const employees = (query: EmployeeQuery, enabled: boolean) => ({ ...get("/api/v1/employees", { params: { query } }), enabled });

/** The my-turn sections, most urgent first, and the view each also appears in besides "all" ("requests": approvals, exit reports and BW-17 change requests to me). */
const SECTIONS = { failed: "failures", due: "deadlines", exits: "requests", decide: "requests", unlocks: "requests", asks: "requests", renewals: "deadlines", insurance: "deadlines", mine: "all", review: "all" } as const satisfies Record<string, View>;
type Section = keyof typeof SECTIONS;

/**
 * Home shows my turn, waiting and scheduled work, refreshed by the shared event stream. A part of the
 * queue this account may not read, or that failed to load, is named above it: the queue never claims "nothing to do"
 * over a part it could not see (governance-16, governance-32).
 * `setup`: the server's setup checklist, composed by the route; null or absent when there is none to show.
 * `setupPending`: the checklist or a read it links from is still arriving, so nothing renders under the loading line yet.
 * `account`: the route's account prompt (a second passkey, governance-20), drawn under the setup slot; it never changes the queue.
 */
export function Home({ setup, setupPending = false, account }: { setup?: ReactNode; setupPending?: boolean; account?: ReactNode } = {}) {
  const [lane, setLane] = useState<Lane>("turn");
  const [view, setView] = useState<View>("all");
  const me = useQuery(meQuery);
  const authz = useQuery(authzQuery);
  const can = granted(authz.data?.capabilities, authz.isError);
  const support = useQuery(activeSupportQuery);
  const myAccess = useQuery(myAccessQuery); // with the queue: GrantNotices lands with it, never pushing it down
  const exitRouted = usePolicyRouted("exit");
  const org = can("org_change_read");
  const hr = can("employee_directory_read", "all");
  const manage = can("employee_directory_manage", "all");
  const insurance = useQuery({ ...filingsQuery({ state: "PENDING" }), enabled: can("employee_directory_manage", "branch") });
  // Unlocks waiting for this close authority as the second person (BW-15).
  const close = can("period_lock_manage", "all");
  const locks = useQuery({ ...inForceLocksQuery, enabled: close });
  const apply = can("org_change_apply");
  const approve = org && can("org_change_approve");
  const exits = can("exit_case_hr_confirm") || can("exit_case_hq_confirm") || can("exit_settlement_manage");
  const claims = session.claims;
  const today = todayKst();
  // The exit steps this user can take, by the statuses that offer them (the server filters).
  const exitStatuses = [
    ...(can("exit_case_hr_confirm") ? (["REPORTED"] as const) : []),
    ...(can("exit_case_hq_confirm") ? (["HR_CONFIRMED"] as const) : []),
    ...(can("exit_settlement_manage") ? (["HQ_CONFIRMED", "SETTLEMENT_READY", "APPROVAL_DRAFTED"] as const) : []),
  ];
  const [identityReview, branchReview, registerReview, contracts, exitCases, failedActions] = useQueries({
    queries: [
      employees({ identity_review_required: true, status: [...CURRENT], limit: LIST }, hr),
      employees({ home_branch_review_required: true, status: [...CURRENT], limit: LIST }, hr),
      employees({ register_review_required: true, status: [...CURRENT, "PRE_HIRE"], limit: LIST }, manage),
      // Contracts ending within the renewal window (or already past while still employed).
      employees({ contract_ending_before: addDays(today, CONTRACT_SOON_DAYS + 1), status: ["ACTIVE", "ON_LEAVE"], limit: LIST }, manage),
      // Exit cases are scoped to the caller's branches, apart from the directory.
      { ...exitCasesQuery({ status: exitStatuses }), enabled: exits },
      // Scheduled actions that could not take effect on their date and were not redone.
      employees({ lifecycle_apply_failed: true, limit: LIST }, manage),
    ],
  });
  const [decide, mineQ, asks] = useQueries({ queries: [
    { ...changesByStatusQuery(["IN_APPROVAL"]), enabled: approve }, { ...myChangesQuery(), enabled: org && !!claims }, { ...openRequestsQuery, enabled: manage },
  ] });

  const reads = [
    ...(can("employee_directory_manage", "branch") ? [["insurance", insurance]] as const : []),
    ...(hr ? [["review", identityReview], ["review", branchReview]] as const : []),
    ...(manage ? [["review", registerReview], ["renewals", contracts], ["failedActions", failedActions], ["requests", asks]] as const : []),
    ...(exits ? [["exits", exitCases]] as const : []),
    ...(org ? [["changes", mineQ]] as const : []),
    ...(approve ? [["decide", decide]] as const : []),
    ...(close ? [["unlocks", locks]] as const : []),
  ];
  const sources = reads.map(([, q]) => q);
  const cover = coverage<Part>(reads.map(([key, q]) => ({ key, state: readState(q) })));
  // Back on Home with cached reads: the ones re-reading on arrival (stale, or changed by a command elsewhere) hold
  // the page once, until they land. The checklist and the queue would otherwise redraw under a pointer already on
  // them (a step done meanwhile collapses, and every step below it moves up).
  const [opened] = useState(Date.now);
  const [caughtUp, setCaughtUp] = useState(false);
  const rereading = !caughtUp && sources.some((q) => q.isFetching && q.dataUpdatedAt < opened);
  if (!rereading && !caughtUp) setCaughtUp(true);
  const loading = setupPending || authz.isPending || myAccess.isPending || rereading || cover.loading;
  // The oldest read on screen: what the queue is current as of.
  const loaded = sources.filter((q) => q.isSuccess).map((q) => q.dataUpdatedAt);
  const asOf = loaded.length ? new Date(Math.min(...loaded)).toISOString() : undefined;

  const toDecideChanges = decide.data?.items.filter((c) => c.draftedBy !== claims?.sub) ?? [];
  // Show only this user’s pending changes here.
  const changes = changeLanes(mineQ.data?.items ?? [], [], { me: claims?.sub, canApply: apply, today });
  const [units, branches] = [useQuery({ ...unitsQuery, enabled: changes.due.length > 0 }), useQuery({ ...branchesQuery, enabled: changes.due.length > 0 })];
  const names = new Map([...(units.data?.items ?? []), ...(branches.data ?? [])].map((u) => [u.id, u.name]));
  const reviewById = new Map<string, Employee>();
  for (const e of [...(identityReview.data?.items ?? []), ...(branchReview.data?.items ?? []), ...(registerReview.data?.items ?? [])]) reviewById.set(e.id, e);
  const review = [...reviewById.values()];
  const reviewKinds = [
    { review: "identity" as const, total: identityReview.data?.total ?? 0 },
    { review: "branch" as const, total: branchReview.data?.total ?? 0 },
    { review: "register" as const, total: registerReview.data?.total ?? 0 },
  ].filter((k) => k.total > 0);
  // Exits waiting on a step this user can take (rejection is never a to-do).
  const exitQueue = (exitCases.data?.items ?? []).flatMap((c) => {
    const next = usableActions(c, can).find((k) => k === "confirm_exit" || k === "prepare_settlement" || (k === "confirm_exit_hq" && !hqNeedsSomeoneElse(exitRouted, c.hr_confirmed_by, claims?.sub)));
    return next ? [{ c, next }] : [];
  });
  // More waiting than one read returns: the list, filtered to open cases, has the rest.
  const exitMore = (exitCases.data?.total ?? 0) > (exitCases.data?.items.length ?? 0);
  const unlocks = toDecide(locks.data?.items ?? [], locks.dataUpdatedAt);
  const failedShown = failedActions.data?.items.some((e) => e.failed_event) ?? false;

  const count: Record<Section, number> = {
    failed: failedShown ? (failedActions.data?.total ?? 0) : 0,
    due: changes.due.length,
    exits: exitQueue.length,
    decide: toDecideChanges.length,
    unlocks: unlocks.length,
    asks: asks.data?.total ?? 0,
    renewals: contracts.data?.items.length ? contracts.data.total : 0,
    insurance: insurance.data?.pending ?? 0,
    mine: changes.mine.length,
    review: review.length,
  };
  const sections = Object.keys(SECTIONS) as Section[];
  const inView = (s: Section, v: View) => v === "all" || SECTIONS[s] === v;
  const viewCount = (v: View) => sections.filter((s) => inView(s, v)).reduce((n, s) => n + count[s], 0);
  const laneCount: Record<Lane, number> = { turn: viewCount("all"), waiting: changes.waiting.length, scheduled: changes.scheduled.length };
  const shown = (s: Section) => inView(s, view) && (count[s] > 0 || (s === "exits" && exitMore));
  const nothing = laneCount.turn === 0 && !exitMore;

  const draft = can("org_change_draft");
  const quiet = setup == null; // the server's rail leads alone: no empty-queue quick links beside it
  const tiles = ([["register", manage], ["import", manage], ["org", draft], ["invite", can("user_manage")]] as const).filter(([, ok]) => ok).map(([k]) => k as Tile);
  const settled = !loading;
  // No grant at all (decisions #18: in the pilot only ops and HR workers sign in), not merely none Home lists.
  const noWork = settled && quiet && !hasWork(can) && !support.data?.can_approve;
  const retry = () => sources.filter((q) => readState(q) === "failed").forEach((q) => void q.refetch());

  return (
    <div className="page">
      <div className="page__head">
        <h1 id="home-title" className="page__title" tabIndex={-1}>{me.data ? t("home.greeting", { name: me.data.display_name }) : t("home.title")}</h1>
        {asOf && <span className="muted num">{t("home.asOf", { time: fmtDateTime(asOf) })}</span>}
      </div>

      {loading && <div className="state muted" role="status">{t("common.loading")}</div>}
      {/* Nothing renders under the loading line while it shows: when it went, whatever had landed below would jump
          up under a pointer already on it. */}
      {!loading && setup}
      {!loading && account}
      {!loading && <GrantNotices />}
      {/* A part refused or failed is named (failed ones with a retry), never read as "nothing to do". */}
      {settled && <CoverageNotice c={cover} retry={retry} />}
      {noWork && <NoWork />}

      {/* A view switch, not an ARIA tab set: toggle buttons announce which lane is showing. The other lanes hold org
          changes only, so a viewer who cannot read them sees none. */}
      {settled && org && (quiet || !nothing || laneCount.waiting + laneCount.scheduled > 0) && (
        <div role="group" aria-label={t("home.lanes")} className="tabs">
          {LANES.map((l) => (
            <button key={l} aria-pressed={lane === l} className={`btn ${lane === l ? "" : "btn--ghost"}`} onClick={() => setLane(l)}>{t(`home.lane.${l}`, { count: laneCount[l] })}</button>
          ))}
        </div>
      )}

      {lane === "turn" && settled && !nothing && (
        <div role="group" aria-label={t("home.views")} className="tabs">
          {VIEWS.map((v) => (
            <button key={v} aria-pressed={view === v} className={`btn ${view === v ? "" : "btn--ghost"}`} onClick={() => setView(v)}>{t(`home.view.${v}`, { count: viewCount(v) })}</button>
          ))}
        </div>
      )}
      {lane === "turn" && settled && !noWork && (
        <>
          {shown("failed") && failedActions.data && <FailedActions page={failedActions.data} />}
          {shown("due") && (
            <QueueSection id="due" title={t("home.due.title", { count: count.due })}>
              <ul className="list-plain">{changes.due.map((c) => <DueRow key={c.id} c={c} today={today} name={(_, id) => names.get(id)} />)}</ul>
            </QueueSection>
          )}
          {shown("exits") && <ExitQueue queue={exitQueue} more={exitMore} facts={(c) => <CaseFacts c={c} />} />}
          {shown("decide") && (
            <QueueSection id="decide" title={t("home.decide.title", { count: count.decide })}>
              <ul className="list-plain">{toDecideChanges.map((c) => <DecideRow key={c.id} c={c} />)}</ul>
            </QueueSection>
          )}
          {shown("unlocks") && <UnlockQueue locks={unlocks} />}
          {shown("asks") && asks.data && <RequestQueue page={asks.data} />}
          {shown("renewals") && contracts.data && <Renewals page={contracts.data} />}
          {shown("insurance") && <QueueSection id="insurance" title={t("statutory.home", { count: count.insurance })}><Link to="/statutory" className={buttonClass()}>{t("statutory.open")}</Link></QueueSection>}
          {shown("mine") && <MineList changes={changes.mine} />}
          {shown("review") && <ReviewRecords people={review} kinds={reviewKinds} />}
          {!nothing && viewCount(view) === 0 && <p className="muted">{t("home.view.empty")}</p>}
          {nothing && quiet && <QueueEmpty next={changes.scheduled.slice(0, 3)} today={today} tiles={tiles} partial={!cover.complete} />}
        </>
      )}
      {lane === "waiting" && <WaitingList changes={changes.waiting} />}
      {lane === "scheduled" && <ScheduledList changes={changes.scheduled} today={today} />}
    </div>
  );
}

/** One-click approval of the next step, with the change summarised in the row. Rejection needs a memo, so it opens the change. */
function DecideRow({ c }: { c: Summary }) {
  const detail = useQuery(changeQuery(c.id));
  const step = detail.data?.approvalSteps.find((s) => s.decision === "PENDING");
  const approve = useCommand({
    run: () =>
      unwrap(
        api.POST("/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", {
          params: { path: { id: c.id, stepId: step!.id } },
          body: { decision: "APPROVED" },
        }),
      ),
    invalidates: ORG_READS,
    // The last approval removes this row (and maybe the section): keep focus on the list's heading.
    onSuccess: () => focusSoon("decide", "queue-empty", "home-title"),
    announce: () => t("org.change.decided.APPROVED", { role: step ? label(APPROVAL_ROLE, step.roleKey) : "" }),
  });
  return (
    <li className="form">
      <div className="row">
        <ChangeLine c={c} />
        <span className="muted">{t("home.decide.drafter", { name: actor(c.draftedByName) })}</span>
        {step && <Chip tone="info">{t("home.decide.turn", { role: label(APPROVAL_ROLE, step.roleKey) })}</Chip>}
        <Link to="/org/changes/$id" params={{ id: c.id }} className="btn btn--ghost">{t("home.decide.review")}</Link>
        {/* Stays disabled until the refreshed next step arrives, so a quick second click can't target a decided step. */}
        <button className="btn btn--primary" disabled={!step || approve.isPending || detail.isFetching} onClick={() => approve.mutate(undefined)}>
          {step ? t("home.decide.approve", { role: label(APPROVAL_ROLE, step.roleKey) }) : t("home.decide.approveAny")}
        </button>
      </div>
      <span className="muted">{c.reason}</span>
      <CommandError error={approve.error} />
    </li>
  );
}

/** An approved change on or past its date, for an apply holder: effectuate it, consequence first. */
function DueRow({ c, today, name }: { c: Summary; today: string; name: Parameters<typeof changeSubject>[1] }) {
  const [confirming, setConfirming] = useState(false);
  // The full proposal says what effectuating moves (a reorganization transfers people). Read with the row, as
  // DecideRow does: read on opening, it landed in the open dialog and moved its buttons under the pointer.
  const detail = useQuery(changeQuery(c.id));
  const effectuate = useCommand({
    run: () => unwrap(api.POST("/api/v1/org-changes/{id}/effectuate", { params: { path: { id: c.id } } })),
    // A reorganization can move people (REASSIGN_ORG_UNIT): their records change too.
    invalidates: [...ORG_READS, "/api/v1/employees"],
    onSuccess: () => {
      setConfirming(false);
      focusSoon("due", "mine", "queue-empty", "home-title");
    },
  });
  return (
    <li className="form">
      <div className="row">
        <ChangeLine c={c} />
        <span className="muted num">{t("home.due.since", { days: -daysUntil(c.effectiveDate, today) })}</span>
        <button className="btn btn--primary" onClick={() => setConfirming(true)}>{t("home.due.effectuate", { name: changeSubject(c, name), kind: label(ORG_CHANGE_KIND, c.kind) })}</button>
      </div>
      <Dialog open={confirming} title={t("org.change.effectuate")} onClose={() => setConfirming(false)}>
        <QueryState q={detail}>{(d) => <EffectuateConsequence d={d} />}</QueryState>
        <CommandError error={effectuate.error} />
        <div className="form__actions">
          <button className="btn" onClick={() => setConfirming(false)}>{t("common.back")}</button>
          <button className="btn btn--primary" disabled={effectuate.isPending || !detail.isSuccess} onClick={() => effectuate.mutate(undefined)}>{t("org.change.effectuate")}</button>
        </div>
      </Dialog>
    </li>
  );
}
