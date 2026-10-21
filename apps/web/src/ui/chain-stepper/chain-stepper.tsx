import type { ReactNode } from "react";
import { t } from "@console/i18n";
import css from "./chain-stepper.module.css";

export type ChainStep = {
  key: string;
  /** Who acts at this step, by name and role (name, title · approves). */
  who: ReactNode;
  state: "done" | "current" | "waiting" | "failed";
  /** When it happened, or whose turn it is (approved 10/1 09:12, my turn). */
  meta?: ReactNode;
  /** What happens once this step is done; shown under the current step only. */
  note?: ReactNode;
  /** A server-computed DeadlineChip for this step. */
  deadline?: ReactNode;
};

/** A multi-party chain (approval, exit, invite, a second person's approval): named people, whose turn it is. */
export function ChainStepper({ steps, label }: { steps: ChainStep[]; label?: string }) {
  return (
    <ol className={css.steps} aria-label={label ?? t("uiChainStepper.label")}>
      {steps.map((s, i) => (
        <li key={s.key} className={css.step} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
          <span className={css.n} aria-hidden="true">{i + 1}</span>
          <span className={css.who}>
            <span className="sr-only">{t(`uiChainStepper.state.${s.state}`)}</span>
            {s.who}
          </span>
          {(s.meta || s.deadline) && <span className={css.meta}>{s.meta}{s.deadline}</span>}
          {s.note && s.state === "current" && <span className={css.note}>{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}
