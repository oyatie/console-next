// SPDX-License-Identifier: LicenseRef-Proprietary
import { AlertTriangle, Clock } from "lucide-react";
import { t } from "@console/i18n";
import s from "./due-cell.module.css";

/**
 * Remaining-days readout for worklist and statutory cells: combines non-colour icons and text with cell-level tones
 * (`over`, `today`, `near`, `far`, `undated`).
 */
export function DueCell({
  days,
  fill = false,
  nearWindow = 7,
}: {
  /** Server-computed days remaining (`< 0` overdue, `0` today, `> 0` future, `null`/`undefined` undated). */
  days: number | null | undefined;
  /** Stretch across a table cell with edge-to-edge background tint on `over` and `today`. */
  fill?: boolean;
  /** Days threshold within which upcoming items take semibold `near` emphasis (`7` by default). */
  nearWindow?: number;
}) {
  const validDays = days != null && Number.isFinite(days) ? days : null;
  const tone =
    validDays == null
      ? "undated"
      : validDays < 0
        ? "over"
        : validDays === 0
          ? "today"
          : validDays <= nearWindow
            ? "near"
            : "far";

  const text =
    validDays == null
      ? t("uiWorklist.undated")
      : validDays < 0
        ? t("uiDeadlineChip.over", { days: -validDays })
        : validDays === 0
          ? t("uiWorklist.today")
          : t("uiDeadlineChip.left", { days: validDays });

  return (
    <data className={s.cell} data-tone={tone} data-fill={fill || undefined} value={validDays == null ? "" : String(validDays)}>
      {tone === "over" ? <AlertTriangle size={12} aria-hidden="true" /> : null}
      {tone === "today" ? <Clock size={12} aria-hidden="true" /> : null}
      <bdi>{text}</bdi>
    </data>
  );
}
