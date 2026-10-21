import { useState, type ReactNode } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTimeShort } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { ChainStepper, type ChainStep } from "../../../ui/chain-stepper/chain-stepper";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { actor } from "../../../lib/labels";
import { effectOf, isClosed, stepStates, type BackKey, type Effect, type ForwardKey } from "../domain/exits";
import { mySub } from "../api";
import { hrConfirmedTitle } from "../present";
import { ConfirmForm } from "./exit-confirm";
import type { SheetSpec } from "./exit-foot";
import { SettlementForm } from "./exit-settlement";
import { useCaseActions } from "./use-case-actions";
import s from "./exit.module.css";

type Case = components["schemas"]["EmployeeExitCase"];
type Status = Case["status"];

type StepProps = {
  k: ForwardKey;
  c: Case;
  aside?: ReactNode;
  sheet?: SheetSpec;
  stale?: Effect | null;
  follow?: ReactNode;
  /** A saved settlement draft moved the case: my own change, followed without a notice. */
  onSaved?: () => void;
  onDone: (message: string) => void;
};
/** The form for a forward step, inline at the current step on the case page or in a sheet over the person's record. */
export function StepForm({ k, onSaved, ...rest }: StepProps) {
  if (k === "prepare_settlement") return <SettlementForm {...rest} onSaved={onSaved} />;
  return <ConfirmForm {...rest} hq={k === "confirm_exit_hq"} />;
}

/** Who takes the next step, when it is not this user. */
const holder = (next: ForwardKey, sameActor: boolean) =>
  next === "confirm_exit_hq" || sameActor ? t("exit.next.otherHq") : t("exit.next.others");

/**
 * The case axis (case-axis-form-at-now): each step done names who did it and when; the current step is
 * marked and its form sits right under the steps, with the back decisions (reject, cancel) at equal height
 * on its left. A closed case shows the steps it reached and its close step.
 */
export function CaseAxis({ c: live, onBack, onDone }: { c: Case; onBack: (k: BackKey) => void; onDone: (message: string) => void }) {
  // The case the open form was built for (C11): a refresh that keeps the step follows along; one that moves the
  // case (someone else took the step) keeps the form, read-only, with who did it, until the user moves on. My
  // own commit follows the next read.
  const [seen, setSeen] = useState(live);
  // `follow` stays set after a settlement save that leaves the status as it was, so the next move by
  // someone else is followed without a notice; clear it on the next read if that matters.
  const [follow, setFollow] = useState(false);
  const c = seen;
  const { next, forward, back, sameActor } = useCaseActions(c);
  const effect = forward && (effectOf(forward, live) ?? effectOf("reject_exit", live));
  // Without an open form there is nothing to keep, and my own step needs no notice: follow at once.
  if (seen !== live && (seen.status === live.status || follow || !forward || (effect && effect.by === mySub()))) {
    setSeen(live);
    if (seen.status !== live.status) setFollow(false);
  }
  const moved = seen.status !== live.status;
  const done = (message: string) => {
    setFollow(true);
    onDone(message);
  };
  const name = c.employee_name;
  const date = fmtDate(c.effective_exit_date);
  // Each done step: the step, then who did what under it (wraps at any width); when, short, on the right.
  const said: Partial<Record<Status, [text: string, when?: string]>> = {
    REPORTED: [t("exit.event.reported", { actor: actor(c.reported_by_name), date }), c.reported_at],
    HR_CONFIRMED: c.hr_confirmed_at ? [t(hrConfirmedTitle(c.exit_event_state), { actor: actor(c.hr_confirmed_by_name), name, date }), c.hr_confirmed_at] : undefined,
    HQ_CONFIRMED: c.hq_confirmed_at ? [t("exit.event.hqConfirmed", { actor: actor(c.hq_confirmed_by_name) }), c.hq_confirmed_at] : undefined,
    SUBMITTED: c.approval_submitted_at ? [t("exit.event.submitted", { actor: actor(c.approval_submitted_by_name) }), c.approval_submitted_at] : undefined,
  };
  const titled = (title: string, text?: string, extra?: ReactNode) => (text ? <>{title}<span className={s.said}>{text}</span>{extra}</> : title);
  const states = stepStates(c);
  const current = states.find((x) => x.state === "current")?.step;
  const steps: ChainStep[] = states.map(({ step, state }) => {
    const [text, when] = state === "current" ? [] : (said[step] ?? []);
    return {
      key: step,
      who: titled(t(`exit.step.${step}`), text),
      state,
      meta: state === "current" && next ? (forward ? t("exit.next.mine") : holder(next, sameActor)) : when && fmtDateTimeShort(when),
    };
  });
  if (isClosed(c))
    steps.push({
      key: c.status,
      who: titled(
        t(`exit.step.${c.status}`),
        t(c.status === "CANCELLED" ? "exit.event.cancelled" : "exit.event.rejected", { actor: actor(c.closed_by_name) }),
        c.closed_reason && <span className={s.quote}>{c.closed_reason}</span>,
      ),
      state: "failed",
      meta: c.closed_at && fmtDateTimeShort(c.closed_at),
    });
  const backRow = back.length > 0 && (
    <span className="row" role="group" aria-label={t("exit.actions")}>
      {back.map((k) => <Button key={k} variant="ghost-danger" onClick={() => onBack(k)}>{t(`exit.action.${k}`)}</Button>)}
    </span>
  );
  return (
    <div className={s.column}>
      <ChainStepper steps={steps} />
      {next && current && (
        <section className={s.now} aria-labelledby="exit-now">
          <h2 id="exit-now" className={s.nowTitle} tabIndex={-1}>{t("exit.now", { step: t(`exit.step.${current}`) })}</h2>
          {forward ? (
            <StepForm
              key={c.status}
              k={forward}
              c={c}
              aside={backRow}
              stale={moved ? (effect || { name: null }) : null}
              onSaved={() => setFollow(true)}
              follow={<Button variant="primary" onClick={() => setSeen(live)}>{t("exit.follow")}</Button>}
              onDone={done}
            />
          ) : (
            <>
              <p className="muted">{t("exit.next", { step: t(`exit.step.${current}`) })} · {holder(next, sameActor)}</p>
              <div className={s.decision}>
                {backRow}
                <span className={s.grow} />
                {sameActor && <DisabledReason control={(p) => <Button variant="primary" {...p}>{t("exit.action.confirm_exit_hq")}</Button>} reason={t("exit.hq.sameActor")} />}
              </div>
            </>
          )}
        </section>
      )}
      {!next && backRow}
    </div>
  );
}
