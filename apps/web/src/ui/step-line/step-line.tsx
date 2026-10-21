import { Check } from "lucide-react";
import s from "./step-line.module.css";

/** One step of a page-wide task: done steps show a check, the current one is marked for assistive tech. */
export type Step = { key: string; label: string; state: "done" | "current" | "waiting" };

/** The steps of a workspace across its head (spec E6: people, edit, check, apply), joined by rules. */
export function StepLine({ steps, label }: { steps: readonly Step[]; label: string }) {
  return (
    <ol className={s.steps} aria-label={label}>
      {steps.map((x, i) => (
        <li key={x.key} className={s.step} data-state={x.state} aria-current={x.state === "current" ? "step" : undefined}>
          {/* The number is drawn (data-n), not text: the step reads as its label alone. */}
          <span className={s.n} aria-hidden data-n={i + 1}>{x.state === "done" ? <Check size={14} strokeWidth={3} /> : null}</span>
          <span>{x.label}</span>
        </li>
      ))}
    </ol>
  );
}
