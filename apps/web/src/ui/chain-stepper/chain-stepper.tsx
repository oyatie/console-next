import type { ReactNode } from "react";
import { Check, Circle, CircleDot, X } from "lucide-react";
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

const GLYPH = { done: Check, current: CircleDot, waiting: Circle, failed: X };
const TONE = { done: "ok", current: "info", waiting: "neutral", failed: "danger" } as const;

/** One line for a list row: the steps around the current one as chips, the rest counted; the tooltip names them all. */
function ChainChips({ steps, label, max }: { steps: ChainStep[]; label: string; max: number }) {
  const at = steps.findIndex(s => s.state === "current" || s.state === "failed");
  const start = Math.max(0, Math.min(at < 0 ? steps.length : at - max + 2, steps.length - max));
  const shown = steps.slice(start, start + max);
  // Only plain-text names can go in a tooltip.
  const full = steps.map(s => `${t(`uiChainStepper.state.${s.state}`)} ${typeof s.who === "string" ? s.who : ""}`.trim()).join(" → ");
  return (
    <ol className={css.chips} aria-label={label} title={full}>
      {shown.map(s => {
        // A state this build does not know still renders, as a waiting step, instead of failing the whole row.
        const Glyph = GLYPH[s.state] ?? Circle;
        return (
          <li key={s.key} className={`chip chip--${TONE[s.state] ?? "neutral"}`} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
            <Glyph size={12} role="img" aria-label={t(`uiChainStepper.state.${s.state}`)} />{s.who}
          </li>
        );
      })}
      {steps.length > shown.length && <li className="chip chip--neutral">{t("uiChainStepper.more", { count: steps.length - shown.length })}</li>}
    </ol>
  );
}

/** A multi-party chain (approval, exit, invite, a second person's approval): named people, whose turn it is. */
export function ChainStepper({ steps, label, variant, max = 3 }: { steps: ChainStep[]; label?: string; variant?: "chips"; max?: number }) {
  if (variant === "chips") return <ChainChips steps={steps} label={label ?? t("uiChainStepper.label")} max={max} />;
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
