import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useDirtyEscape } from "../../../lib/react/dirty-escape";
import { landed } from "../../../lib/react/landed";
import { APPROVAL_ROLE, actor, label } from "../../../lib/labels";
import { ORG_READS } from "../../../reference/org/api";
import { Composer } from "../../../ui/composer/composer";
import { commitLabel } from "../../../ui/composer/actions";
import { Button } from "../../../ui/button/button";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { changeCommands, changesByStatusQuery, me, refusalOf } from "../api";
import { describeOp, type Names, type NextStep } from "../present";
import type { Note } from "./use-note";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
type Decide = Extract<NextStep, { kind: "decide" }>;
type Refetch = () => Promise<{ data?: Detail }>;

/**
 * The decision on the step this person holds, on the shared approval card: what is decided (ops, reason,
 * people, the previous step's note) sits above approve and reject, which stand side by side; reject needs a
 * reason. There is no request-changes yet (BW-02), so the card draws none. Key it by the step id: after a
 * decision only the receipt shows, and the next step's card opens only on request, so a second click can
 * never land on the next step (role keys are not checked yet, BW-01).
 */
export function ChangeDecision({ d, s, n, refetch, onNote, onReopen }: {
  d: Detail;
  s: Decide;
  n: Names;
  refetch: Refetch;
  onNote: (note: Note) => void;
  onReopen: () => void;
}) {
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  // Esc closes the reject form, twice once a reason is typed.
  const [rejecting, setRejecting] = useState(false);
  const role = label(APPROVAL_ROLE, s.step.roleKey);
  const self = me();
  const decide = useCommand({
    run: async (decision: "APPROVED" | "REJECTED") => {
      const memo = (decision === "REJECTED" ? reason : comment).trim() || undefined;
      try {
        await landed(() => changeCommands(d.id).decide(s.step.id, decision, memo), refetch, (x) => {
          // Landed only as this decision: the same person may have decided the step otherwise in another tab.
          const st = x.approvalSteps.find((y) => y.id === s.step.id);
          return st?.decidedBy === self && st?.decision === decision;
        });
        // The record must show this step decided before the receipt offers the next one: re-arming on the
        // cached copy would put this step's decision back under the viewer's next click.
        await refetch();
        return { decision };
      } catch (e) {
        // Someone else decided this step first: say who and when, never a generic error.
        const now = refusalOf(e) === "conflict" ? (await refetch()).data?.approvalSteps.find((st) => st.id === s.step.id) : undefined;
        if (now && now.decision !== "PENDING") return { decision, elsewhere: now };
        throw e;
      }
    },
    invalidates: ORG_READS,
    onSuccess: ({ decision, elsewhere }) => {
      if (elsewhere)
        return onNote({ message: t("live.notice.done_elsewhere", { actor: actor(elsewhere.decidedByName), time: fmtDateTime(elsewhere.decidedAt) }) });
      const next = decision === "APPROVED" ? s.next : undefined;
      onNote({
        message: t(`orgChange.decided.${decision}`, { role, code: d.code }),
        hold: true,
        actions: next ? (
          <Button onClick={onReopen}>{t("orgChange.decided.openNextStep", { role: label(APPROVAL_ROLE, next.roleKey) })}</Button>
        ) : (
          <NextApproval exclude={d.id} />
        ),
      });
    },
  });
  const { ref, armed } = useDirtyEscape<HTMLElement>(reason.trim() !== "", () => {
    setReason("");
    setRejecting(false);
    focusSoon("next-step");
  });
  const prev = s.prev;
  return (
    <section id="next-step" ref={ref} tabIndex={-1} aria-label={t("orgChange.next.title")} className={css.receipt}>
      <Composer
        layout="page"
        kicker={<>{t("orgChange.list.title")} · <span className="code">{d.code}</span></>}
        subtitle={t("orgChange.decide.step", { role, n: s.n, total: s.total })}
        title={t("orgChange.turn", { role })}
        action={{ kind: "orgChange", mode: rejecting ? "reject" : "approve" }}
        tone={rejecting ? "danger" : "primary"}
        pending={decide.isPending}
        consequence={rejecting ? t("orgChange.decide.reject.consequence") : s.next ? t("orgChange.decide.approve.next", { role: label(APPROVAL_ROLE, s.next.roleKey) }) : t("orgChange.decide.approve.last", { date: fmtDate(d.effectiveDate) })}
        blocked={rejecting && !reason.trim() ? { reason: t("orgChange.decide.reject.needReason") } : undefined}
        onSubmit={() => { if (!rejecting || reason.trim()) decide.mutate(rejecting ? "REJECTED" : "APPROVED"); }}
        onClose={rejecting ? () => setRejecting(false) : undefined}
        secondary={!rejecting && <Button onClick={() => setRejecting(true)}>{commitLabel({ kind: "orgChange", mode: "reject" })}</Button>}
        notice={<CommandError error={decide.error} />}
      >
        {rejecting && <>
          <Field label={t("orgChange.decide.reject.reason")} required example={t("orgChange.decide.reject.example")}>
            {(p) => <TextArea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          {armed && <p className="muted" role="status">{t("orgChange.escConfirm")}</p>}
        </>}
        <ol className={css.ops}>{d.proposal.map((op, i) => <li key={i}>{describeOp(op, n)}</li>)}</ol>
        <blockquote className={css.quote}>{d.reason}</blockquote>
        <p className="num">{t("orgChange.headcount")} · {t("orgChange.headcount.value", { count: d.headcount })}</p>
        {prev?.memo && <p className="muted">{t("orgChange.decide.prevMemo", { role: label(APPROVAL_ROLE, prev.roleKey), name: actor(prev.decidedByName), memo: prev.memo })}</p>}
        {s.prevByMe && <p className={css.caution}>{t("orgChange.decide.sameDecider")}</p>}
        <details>
          <summary>{t("orgChange.decide.note")}</summary>
          <Field label={t("orgChange.decide.note.label", { role })} required={false}>
            {(p) => <TextArea {...p} value={comment} onChange={(e) => setComment(e.target.value)} />}
          </Field>
        </details>
      </Composer>
    </section>
  );
}

/** The next change waiting on an approval that this person did not draft (the queue continues here). */
function NextApproval({ exclude }: { exclude: string }) {
  const q = useQuery(changesByStatusQuery(["IN_APPROVAL"], { limit: 20 }));
  const self = me();
  const next = q.data?.items.find((c) => c.id !== exclude && c.draftedBy !== self);
  if (!next) return null;
  return <Link to="/org/changes/$id" params={{ id: next.id }} className="btn">{t("orgChange.decided.openNext")}</Link>;
}
