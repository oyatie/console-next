// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import s from "./status-bar.module.css";

type StatusBarTone = "default" | "strong" | "attention";

type StatusBarSegment = {
  /** Stable identifier of the segment. */
  id: string;
  /** Inline fact rendered in the segment. */
  content: ReactNode;
  /** Emphasis role: `strong` (`--on-chrome`), `attention` (`--chrome-attention`), or `default` (`--on-chrome-muted`); index `0` defaults to `strong`. */
  tone?: StatusBarTone;
};

/**
 * Compact `24px` bottom status strip inside the desktop application frame (`[data-surface="chrome"]`). Displays static
 * workspace facts without `aria-live` announcements.
 */
export function StatusBar({
  label,
  segments,
  trailing,
}: {
  /** Accessible name of the status bar footer landmark; defaults to `shell.status.label`. */
  label?: string;
  /** Leading status segments; index `0` defaults to `tone="strong"` when `tone` is omitted. */
  segments: readonly StatusBarSegment[];
  /** Optional right-aligned segment placed after the flexible spacer. */
  trailing?: ReactNode;
}) {
  if (segments.length === 0 && !trailing) return null;
  const resolvedLabel = label ?? t("shell.status.label");

  return (
    <footer aria-label={resolvedLabel} data-surface="chrome" className={s.bar}>
      <div className={s.segments}>
        {segments.map((seg, index) => {
          const tone: StatusBarTone = seg.tone ?? (index === 0 ? "strong" : "default");
          return (
            <div key={seg.id} className={s.segment} data-tone={tone}>
              {seg.content}
            </div>
          );
        })}
      </div>
      {trailing ? <div className={s.trailing}>{trailing}</div> : null}
    </footer>
  );
}
