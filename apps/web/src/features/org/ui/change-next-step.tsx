import { useState, type ReactNode } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { APPROVAL_ROLE, actor, label } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { ORG_READS } from "../../../reference/org/api";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { blockerCount, changeCommands, movedElsewhere, probed, refusalOf } from "../api";
import { submittedText, submitWords, type Names, type NextStep } from "../present";
import { CancelDialog } from "./cancel-dialog";
import { ChangeApply } from "./change-apply";
import { ChangeDecision } from "./change-decision";
import { ChangeRedraft } from "./change-redraft";
import { elsewhereNote, type Note } from "./use-note";
import { useOrgRouted } from "./use-org-routed";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
type Report = components["schemas"]["OrgChangePreflightReport"];
type Refetch = () => Promise<{ data?: Detail }>;

/** The next-step card: the one thing this change asks of this viewer now, with what it does said above the button. */
export function ChangeNextStep(p: {
  d: Detail;
  s: NextStep;
  title: string;
  n: Names;
  today: string;
  report?: Report;
  hold: boolean;
  editor: ReactNode;
  refetch: Refetch;
  onNote: (n: Note) => void;
  onReopen: () => void;
  onEdit: () => void;
  onPreflight: () => void;
}) {
  const { d, s, title } = p;
  const lapsed = d.status === "IN_APPROVAL" && d.effectiveDate < p.today;
  const memo = "step" in s ? s.step?.memo : undefined;
  // The decision is its own card (the shared approval card), not a card inside this one.
  if (s.kind === "decide" && !p.hold) return <ChangeDecision key={s.step.id} d={d} s={s} n={p.n} refetch={p.refetch} onNote={p.onNote} onReopen={p.onReopen} />;
  return (
    <section className="card panel" aria-labelledby="next-step">
      <h2 id="next-step" className="panel__title" tabIndex={-1}>{t("orgChange.next.title")}</h2>
      <div className={css.next}>
        {s.kind === "submit" && <Submit d={d} title={title} report={p.report} refetch={p.refetch} onNote={p.onNote} onEdit={p.onEdit} onPreflight={p.onPreflight} />}
        {s.kind === "submit" && p.editor}
        {s.kind === "draftReadOnly" && <p>{t("orgChange.next.draft.readOnly")}</p>}
        {(s.kind === "awaitDecision" || s.kind === "decide") && (
          <>
            <p>{t("orgChange.turn", { role: label(APPROVAL_ROLE, s.step.roleKey) })}</p>
            <p className="muted">{s.kind === "awaitDecision" && s.drafter ? t("orgChange.turn.drafter") : t("orgChange.turn.who")}</p>
          </>
        )}
        {lapsed && <p className={css.caution}>{t("orgChange.lapsed", { date: fmtDate(d.effectiveDate) })}</p>}
        {(s.kind === "scheduled" || s.kind === "awaitApply" || s.kind === "settle") && (
          <ChangeApply d={d} s={s} title={title} n={p.n} refetch={p.refetch} onNote={p.onNote} />
        )}
        {(s.kind === "redraft" || s.kind === "rejected") && s.step && (
          <>
            <p>{t("orgChange.rejected.by", { name: actor(s.step.decidedByName), role: label(APPROVAL_ROLE, s.step.roleKey) })}</p>
            {memo && <blockquote className={css.quote}>{t("orgChange.rejected.memo", { memo })}</blockquote>}
          </>
        )}
        {s.kind === "redraft" && <Redraft d={d} title={title} memo={memo} />}
        {s.kind === "rejected" && <p className="muted">{t("orgChange.rejected.readOnly")}</p>}
        {s.kind === "applied" && <p>{t("orgChange.applied", { date: fmtDate(d.effectiveDate) })}</p>}
        {s.kind === "archived" && <p>{t("orgChange.archived", { date: fmtDate(d.updatedAt) })}</p>}
        {s.kind === "cancelled" && <Cancelled d={d} />}
      </div>
    </section>
  );
}

function Redraft({ d, title, memo }: { d: Detail; title: string; memo?: string }) {
  const [open, setOpen] = useState(false);
  if (open) return <ChangeRedraft d={d} title={title} memo={memo} onClose={() => { setOpen(false); focusSoon("next-step"); }} />;
  return (
    <>
      <div className={css.bar}>
        <Button variant="primary" aria-describedby="redraft-consequence-open" onClick={() => { setOpen(true); focusSoon("redraft"); }}>{t("orgChange.redraft")}</Button>
      </div>
    </>
  );
}

function Cancelled({ d }: { d: Detail }) {
  const e = [...d.events].reverse().find((x) => x.action === "cancel");
  return (
    <>
      <p>{t("orgChange.cancelledBy", { name: actor(e?.actorName) })}</p>
      {e?.reason && <blockquote className={css.quote}>{e.reason}</blockquote>}
    </>
  );
}

/** Submit straight from the record: the live preflight is on the page, so no dialog re-runs it. */
const SUBMITTED: Detail["status"][] = ["IN_APPROVAL", "APPROVED", "APPLIED", "SETTLING"];

function Submit({ d, title, report, refetch, onNote, onEdit, onPreflight }: {
  d: Detail;
  title: string;
  report?: Report;
  refetch: Refetch;
  onNote: (n: Note) => void;
  onEdit: () => void;
  onPreflight: () => void;
}) {
  const routed = useOrgRouted();
  const [cancelling, setCancelling] = useState(false);
  const submit = useCommand({
    run: () =>
      // Submitted: in approval, or (decisions #26, no approval) approved for its effective date, applied, or settling a dissolve.
      probed(() => changeCommands(d.id).submit(), refetch, (x) => SUBMITTED.includes(x.status), (x) => movedElsewhere(x, SUBMITTED)).then(
        (other) => ({ blocked: 0, other }),
        (e: unknown) => {
          if (refusalOf(e) !== "preflight_blocked") throw e;
          onPreflight();
          return { blocked: blockerCount(e), other: undefined };
        },
      ),
    invalidates: ORG_READS,
    onSuccess: ({ blocked, other }) =>
      other ? onNote(elsewhereNote(other)) : onNote({
        message: blocked
          ? t("orgChange.unsent", { count: blocked })
          : submittedText(d, title, routed, todayKst()),
      }),
  });
  const blockers = report?.blockers.length ?? 0;
  const { label: submitText, consequence } = submitWords(d, title, routed, todayKst());
  return (
    <>
      <p id="submit-consequence" className={css.consequence} role="note">{consequence}</p>
      <CommandError error={submit.error} />
      <div className={css.bar}>
        {blockers > 0 ? (
          <DisabledReason
            control={(p) => <Button variant="primary" {...p}>{submitText}</Button>}
            reason={t("orgChange.submit.blocked", { count: blockers })}
            remedy={<Button variant="ghost" onClick={() => focusSoon("preflight")}>{t("orgChange.submit.seePreflight")}</Button>}
          />
        ) : (
          <Button variant="primary" disabled={submit.isPending} aria-describedby="submit-consequence" onClick={() => submit.mutate(undefined)}>
            {submitText}
          </Button>
        )}
        <Button onClick={onEdit}>{t("orgChange.edit")}</Button>
        <span className={css.spacer} />
        <Button variant="ghost" className="btn--danger" onClick={() => setCancelling(true)}>{t("orgChange.cancel")}</Button>
      </div>
      <CancelDialog d={d} title={title} scheduled={false} open={cancelling} onClose={() => setCancelling(false)} refetch={refetch} onNote={onNote} />
    </>
  );
}
