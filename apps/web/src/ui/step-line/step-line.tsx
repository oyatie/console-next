import { Check } from "lucide-react";
import { t } from "@console/i18n";
import s from "./step-line.module.css";

/** One step of a page-wide task: done steps show a check, and every state is told to assistive tech. */
export type Step = { key: string; label: string; state: "done" | "current" | "waiting" };

/** The steps of a workspace across its head (spec E6: people, edit, check, apply), joined by rules. */
export function StepLine({ steps, label }: { steps: readonly Step[]; label: string }) {
  return (
    <ol className={s.steps} aria-label={label}>
      {steps.map((x, i) => {
        // Only the box shows that a step is done or waiting, so the box is named with that state. aria-current marks the current step.
        const state = x.state === "done" || x.state === "waiting" ? t(`uiStepLine.state.${x.state}`) : undefined;
        return (
          <li key={x.key} className={s.step} data-state={x.state} aria-current={x.state === "current" ? "step" : undefined}>
            {/* The number is drawn (data-n), not text: the place of a step comes from the order of the list. */}
            <span className={s.n} role={state && "img"} aria-label={state} aria-hidden={!state || undefined} data-n={i + 1}>{x.state === "done" ? <Check size={14} strokeWidth={3} /> : null}</span>
            <span>{x.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
