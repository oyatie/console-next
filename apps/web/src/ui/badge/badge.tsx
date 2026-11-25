// SPDX-License-Identifier: LicenseRef-Proprietary
import { fmtNumber } from "@console/i18n/format";
import s from "./badge.module.css";

type BadgeTone = "neutral" | "attention" | "inverse";

/**
 * A compact count pill beside a navigation item, tab, or primary command. Renders `<data>` so importing
 * `Badge` never increments a screen's standing-text block count.
 */
export function Badge({
  count,
  more = false,
  tone = "neutral",
}: {
  /** Numeric count formatted with locale separators. */
  count: number;
  /** The count is a lower bound (the server stopped counting), so it reads with a plus. */
  more?: boolean;
  /** `attention` for actionable frame counts, `inverse` inside a primary button, `neutral` elsewhere. */
  tone?: BadgeTone;
}) {
  return (
    <data value={String(count)} className={s.badge} data-tone={tone}>
      {more ? `${fmtNumber(count)}+` : fmtNumber(count)}
    </data>
  );
}
