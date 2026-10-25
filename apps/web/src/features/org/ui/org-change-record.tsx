import { ReceiptReference } from "../../../ui/composer/receipt-reference";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { todayKst } from "../../../lib/pure/today";
import { useCan } from "../../../reference/authz/ui/use-can";
import { unitsQuery } from "../../../reference/org/api";
import { GateRail } from "../../../ui/gate-rail";
import { Receipt } from "../../../ui/receipt/receipt";
import { Timeline } from "../../../ui/timeline";
import { changeCommands, changeQuery, changeUnitId, me } from "../api";
import { changeRail, changeTitle, describeOp, eventTitle, nextStep, submittedText, type Names } from "../present";
import { ChangeChain } from "./change-chain";
import { ChangeHead } from "./change-head";
import { ChangeNextStep } from "./change-next-step";
import { ChangePreflight } from "./change-preflight";
import { ChangeSettlement } from "./change-settlement";
import { DraftEditor } from "./draft-editor";
import { UnitDiff } from "./unit-parts";
import { useChangeNames } from "./use-change-names";
import { useNote } from "./use-note";
import { useOrgRouted } from "./use-org-routed";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
const route = getRouteApi("/app/org/changes/$id");

/** One org change: what it changes, where it stands, and the next step it asks of this viewer. */
export function OrgChange() {
  const { id } = route.useParams();
  // Opened from the list or Home, the record re-reads at once: the row just seen may be newer than the cache.
  const change = useQuery({ ...changeQuery(id), refetchOnMount: "always" });
  // Until that re-read lands, a cached record stays off screen: a newer one (rejected meanwhile, say) would
  // otherwise land a moment later and move every action on the page under a pointer already on one.
  const [opened] = useState(Date.now);
  const settling = change.isFetching && change.dataUpdatedAt < opened;
  return (
    <div className="page">
      <QueryState q={settling ? { ...change, isPending: true } : change} keepOnLoss back={{ to: "/org/changes", label: t("orgChange.list.title") }} layout="record">{(d) => <Record key={d.id} d={d} refetch={change.refetch} />}</QueryState>
    </div>
  );
}

function Record({ d, refetch }: { d: Detail; refetch: () => Promise<{ data?: Detail }> }) {
  const n = useChangeNames();
  const can = useCan();
  const today = todayKst();
  const routed = useOrgRouted();
  const title = changeTitle(d, n);
  const s = nextStep(d, { me: me(), can, today, routed });
  const { note, show, clear } = useNote();
  const { unsent, done } = route.useSearch();
  const navigate = route.useNavigate();
  const editable = d.status === "DRAFT" || d.status === "PRECHECKED";
  const [editing, setEditing] = useState(false);

  // Preflight only reads (it persists nothing), so an open draft shows its current blockers without a click,
  // and again whenever the draft changed under it.
  const preflight = useCommand({ run: () => changeCommands(d.id).preflight() });
  const report = editable ? (preflight.data?.preflight ?? d.preflight) : undefined;
  const checked = useRef<string>(undefined);
  useEffect(() => {
    if (!editable || preflight.isPending || checked.current === d.updatedAt) return;
    checked.current = d.updatedAt;
    preflight.mutate(undefined);
  }, [editable, d.updatedAt, preflight]);

  // Focus starts on the title (3.8); a handed-over receipt below takes it instead.
  useEffect(() => focusSoon("change-title"), []);

  // A receipt handed over by the page that sent the user here is shown once, then dropped from the URL.
  useEffect(() => {
    if (!done) return;
    const unit = changeUnitId(d);
    const message =
      done === "submitted" ? submittedText(d, title, routed, today)
      : done === "redrafted" ? t("orgChange.receipt.redrafted", { code: d.code })
      : t("orgChange.receipt.drafted", { code: d.code });
    show({ message, actions: unit && <Link to="/org" search={{ sel: unit }}>{t("orgChange.receipt.backToOrg")}</Link> });
    void navigate({ search: (x) => ({ ...x, done: undefined }), replace: true });
  }, [done, d, title, show, navigate, routed, today]);

  // The draft left DRAFT elsewhere while it was being edited: the editor is gone, and the page says so.
  const leftDraft = editing && !editable;

  const rail = changeRail(d);
  const deciding = s.kind === "decide" && !note?.hold;
  const unit = changeUnitId(d);
  const place = unit ? { sel: unit } : undefined;
  return (
    <>
      <ChangeHead d={d} title={title} today={today} />
      {note && (
        <div id="change-receipt" tabIndex={-1} className={css.receipt}>
          <Receipt state="recorded" message={note.message} meta={<ReceiptReference value={d.code} />} actions={note.actions} />
        </div>
      )}
      {unsent && editable && report && report.blockers.length > 0 && <div className="alert" role="alert">{t("orgChange.unsent", { count: report.blockers.length })}</div>}
      {leftDraft && <p className="notice" role="status">{t("orgChange.edit.submittedElsewhere", { time: fmtDateTime(d.updatedAt) })}</p>}
      <GateRail steps={rail.steps} current={rail.current} failed={rail.failed} />
      <div className={css.cols}>
        <div className={`page__sub ${css.main}`}>
          <ChangeNextStep
            d={d}
            s={s}
            title={title}
            n={n}
            today={today}
            report={report}
            hold={!!note?.hold}
            editor={editing && <DraftEditor d={d} refetch={refetch} onSaved={() => preflight.mutate(undefined)} onNote={show} onClose={() => setEditing(false)} />}
            refetch={refetch}
            onNote={show}
            onReopen={clear}
            onEdit={() => setEditing(true)}
            onPreflight={() => preflight.mutate(undefined)}
          />
          <Proposal d={d} n={n} brief={deciding} />
          {report && (
            <ChangePreflight d={d} report={report} checking={preflight.isPending} onRerun={() => preflight.mutate(undefined)} onEdit={() => setEditing(true)} />
          )}
          <CommandError error={preflight.error} />
          {d.approvalSteps.length > 0 && <ChangeChain d={d} />}
          {d.settlementItems.length > 0 && <ChangeSettlement d={d} refetch={refetch} onNote={show} />}
        </div>
        <aside className="card panel" aria-labelledby="history">
          <h2 id="history" className="panel__title">{t("orgChange.history")}</h2>
          {place && <Link to="/org" search={place}>{t("orgChange.openUnit")}</Link>}
          <Timeline items={[...d.events].reverse().map((e, i) => ({ key: `${i}`, at: e.at, ...eventTitle(e) }))} />
        </aside>
      </div>
    </>
  );
}

/**
 * What the change does, and why. The affected-people count shows here once it is no longer a draft (D3).
 * `brief` while the viewer decides: the decision card already states the ops, reason and count, so only the
 * before/after preview is added, which the approver needs to judge a move or a dissolution.
 */
function Proposal({ d, n, brief }: { d: Detail; n: Names; brief: boolean }) {
  const draft = d.status === "DRAFT" || d.status === "PRECHECKED";
  if (brief) return <Preview d={d} n={n} card />;
  return (
    <section className="card panel" aria-labelledby="proposal">
      <h2 id="proposal" className="panel__title">{t("orgChange.proposal")}</h2>
      <ol className={css.ops}>{d.proposal.map((op, i) => <li key={i}>{describeOp(op, n)}</li>)}</ol>
      <dl className="kv">
        <dt>{t("orgChange.reason")}</dt>
        <dd>{d.reason}</dd>
        {!draft && (
          <>
            <dt>{t("orgChange.headcount")}</dt>
            <dd className="num">{t(d.status === "APPLIED" ? "orgChange.headcount.moved" : "orgChange.headcount.value", { count: d.headcount })}</dd>
          </>
        )}
      </dl>
      <Preview d={d} n={n} />
    </section>
  );
}

const PREVIEWED = new Set<string>(["CREATE_ORG_UNIT", "RENAME_ORG_UNIT", "MOVE_ORG_UNIT", "DISSOLVE_ORG_UNIT", "REASSIGN_ORG_UNIT"]);
/**
 * What changes, while the change is not applied yet: each unit op before and after, from today's tree (the same
 * preview the proposal card drew). Region and branch ops have no tree; their sentence above says it all.
 * each op is previewed on its own against today's tree, so an op under a unit the same draft creates
 * shows no tree; replay the ops in order when multi-op drafts need it.
 */
function Preview({ d, n, card }: { d: Detail; n: Names; card?: boolean }) {
  const units = useQuery(unitsQuery);
  const pending = d.status === "DRAFT" || d.status === "PRECHECKED" || d.status === "IN_APPROVAL" || d.status === "APPROVED";
  const ops = d.proposal.filter((op) => PREVIEWED.has(op.op));
  if (!pending || !units.data || ops.length === 0) return null;
  const then = t("orgPropose.diff.then", { date: fmtDate(d.effectiveDate) });
  const body = (
    <>
      <h3 className={css.formHead}>{t("orgChange.preview")}</h3>
      {ops.map((op, i) => <UnitDiff key={i} units={units.data.items} op={op} summary={describeOp(op, n)} then={then} />)}
    </>
  );
  return card ? <section className="card panel" aria-label={t("orgChange.proposal")}>{body}</section> : body;
}
