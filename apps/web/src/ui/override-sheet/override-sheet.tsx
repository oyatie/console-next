import type { ReactNode } from "react";
import { Button } from "react-aria-components";
import { Flag, KeyRound, ShieldCheck } from "lucide-react";
import { t } from "@console/i18n";
import { Dialog } from "../dialog";
import { ChainStepper, type ChainStep } from "../chain-stepper/chain-stepper";
import css from "./override-sheet.module.css";

export type OverrideRisk = "low" | "mid" | "high";
/** A step-up assertion is bound to the request: the action and a short form of the payload hash. */
export type StepUpBinding = { action: string; hash: string; confirmedAt?: string };

/**
 * How the exception proceeds, by risk (server-decided): recorded only; a named second person approves;
 * the requester confirms with a passkey; or, when nobody else holds the right, passkey + notice + review flag.
 */
export type OverrideRoute =
  | { kind: "record" }
  | { kind: "second"; steps: ChainStep[] }
  | { kind: "step-up"; binding: StepUpBinding }
  | { kind: "sole-holder"; binding: StepUpBinding; notified: number };

/**
 * Governed-exception sheet for a soft rule the server lets a person override. It states the rule check as a fact, takes a
 * reason (the slot: DS-02 ReasonField, "other" needs a memo) and shows the route the server chose. The commit stays
 * disabled, with why beside it, until the reason is complete; it reads "confirm with a passkey and ..." while a passkey is
 * still owed. Closing is blocked while the command is in flight.
 */
export function OverrideSheet(p: {
  open: boolean;
  /** What is being excepted, and for whom (backdate request · a transfer). */
  title: string;
  rule: { title: ReactNode; detail: ReactNode; code?: string };
  risk: OverrideRisk;
  route: OverrideRoute;
  reason: ReactNode;
  reasonComplete: boolean;
  /** Verb + object, without the passkey prefix (request a backdate from a named manager; confirm as an exception). */
  commitLabel: string;
  onCommit: () => void;
  onClose: () => void;
  pending?: boolean;
}) {
  const r = p.route;
  const binding = r.kind === "step-up" || r.kind === "sole-holder" ? r.binding : undefined;
  const owesPasskey = binding !== undefined && !binding.confirmedAt;
  const label = owesPasskey ? t("uiOverrideSheet.stepUp", { action: p.commitLabel }) : p.commitLabel;
  return (
    <Dialog open={p.open} title={p.title} onClose={p.onClose} dismissable={!p.pending}>
      <div className={css.fact}>
        <div className={css.factTop}>
          <span>{p.rule.title}</span>
          <span className={css.risk} data-risk={p.risk}>{t(`uiOverrideSheet.risk.${p.risk}`)}</span>
        </div>
        <span>{p.rule.detail}</span>
        {p.rule.code && <span className="code">{p.rule.code}</span>}
      </div>
      {p.reason}
      {r.kind === "second" && <ChainStepper steps={r.steps} label={t("uiOverrideSheet.route")} />}
      {r.kind === "sole-holder" && (
        <ChainStepper
          label={t("uiOverrideSheet.route")}
          steps={[
            { key: "passkey", who: t("uiOverrideSheet.sole.passkey"), state: r.binding.confirmedAt ? "done" : "current", meta: t("uiOverrideSheet.sole.passkey.meta") },
            { key: "notify", who: t("uiOverrideSheet.sole.notify", { count: r.notified }), state: "waiting", meta: t("uiOverrideSheet.auto") },
            { key: "review", who: t("uiOverrideSheet.sole.review"), state: "waiting", meta: t("uiOverrideSheet.sole.review.meta") },
          ]}
        />
      )}
      {binding && (
        <div className={css.stepUp} data-ok={Boolean(binding.confirmedAt)}>
          {binding.confirmedAt ? <ShieldCheck aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
          <span>
            {binding.confirmedAt ? t("uiOverrideSheet.stepUp.done", { at: binding.confirmedAt }) : t("uiOverrideSheet.stepUp.owed")}
            <span className={css.bind}>{t("uiOverrideSheet.binding", { action: binding.action, hash: binding.hash })}</span>
          </span>
        </div>
      )}
      <div className="form__actions">
        <Button className="btn" isDisabled={p.pending} onPress={p.onClose}>{t("uiOverrideSheet.back")}</Button>
        {!p.reasonComplete && <span className={css.why}>{t("uiOverrideSheet.reasonMissing")}</span>}
        <Button className="btn btn--primary" isDisabled={!p.reasonComplete} isPending={p.pending} onPress={p.onCommit}>
          {owesPasskey && <KeyRound aria-hidden="true" />}
          {label}
        </Button>
      </div>
    </Dialog>
  );
}

/** The purple exception mark on a record that went through an exception. Purple means exactly this, nothing else. */
export const ExceptionMark = () => (
  <span className={css.mark}>
    <Flag aria-hidden="true" />
    {t("uiOverrideSheet.mark")}
  </span>
);
