import type { ReactNode } from "react";
import { t } from "@console/i18n";
import css from "./deadline-chip.module.css";

// the far/due/over tones live in this module, not as variants of the shared ui/chip.tsx (another owner's
// file); fold them in when Chip gains its `due`/`over`/`exception` variants (DS-08 chip half).

/**
 * The server's clock severity (BW-05). The tone comes only from here, never from a client threshold:
 * `due` follows the server’s configured display window, `over` a legal clock past its date, `far` everything else
 * (a scheduled act, a contract outside that window).
 */
export type ClockSeverity = "far" | "due" | "over";

/**
 * D-n chip, optionally with what is due and its basis (starting event + legal article) beside it.
 * `days` is the server's count of days left (negative once overdue); the client never derives it.
 */
export function DeadlineChip({ severity, days, children, basis, interestAccruing }: {
  severity: ClockSeverity;
  days: number;
  /** What is due and the date, e.g. the settlement for a named person · due 29 Sep. */
  children?: ReactNode;
  basis?: ReactNode;
  /** The server says late-payment interest is accruing (shown only on `over`). */
  interestAccruing?: boolean;
}) {
  const label = days > 0 ? t("uiDeadlineChip.left", { days }) : days === 0 ? t("uiDeadlineChip.today") : t("uiDeadlineChip.over", { days: -days });
  const chip = <span className={`chip ${css[severity]}`}>{label}</span>;
  if (!children && !basis) return chip;
  return (
    <div className={css.clock}>
      {chip}
      {children && <span>{children}</span>}
      {(basis || (severity === "over" && interestAccruing)) && (
        <span className={css.basis}>
          {basis}
          {severity === "over" && interestAccruing && <span className={css.interest}>{t("uiDeadlineChip.interest")}</span>}
        </span>
      )}
    </div>
  );
}
