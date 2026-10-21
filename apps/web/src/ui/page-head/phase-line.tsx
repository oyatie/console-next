import type { ReactNode } from "react";
import s from "./page-head.module.css";

/**
 * The phase line of a page head (design-language §4.3, kit .phase): a dot in the phase's colour, then what the phase
 * means for this view, in the caller's words (setup: changes apply at once and can be undone; operating: changes
 * apply on their effective date). The words carry the phase; the dot only repeats it.
 */
export function PhaseLine({ phase, children }: { phase: "setup" | "operating"; children: ReactNode }) {
  return (
    <span className={s.phase} data-phase={phase}>
      <span className={s.dot} aria-hidden />
      {children}
    </span>
  );
}
