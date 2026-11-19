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
  const tone =
    days == null
      ? "undated"
      : days < 0
        ? "over"
        : days === 0
          ? "today"
          : days <= nearWindow
            ? "near"
            : "far";

  const text =
    days == null
      ? t("uiWorklist.undated")
      : days < 0
        ? t("uiDeadlineChip.over", { days: -days })
        : days === 0
          ? t("uiWorklist.today")
          : t("uiDeadlineChip.left", { days });

  return (
    <data className={s.cell} data-tone={tone} data-fill={fill || undefined} value={days == null ? "" : String(days)}>
      {tone === "over" ? <AlertTriangle size={12} aria-hidden="true" /> : null}
      {tone === "today" ? <Clock size={12} aria-hidden="true" /> : null}
      <bdi>{text}</bdi>
    </data>
  );
}
