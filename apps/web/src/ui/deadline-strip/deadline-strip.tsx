// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { PaneHead } from "../pane-grid/pane-grid";
import s from "./deadline-strip.module.css";

type StripDay = {
  /** ISO date (`YYYY-MM-DD`) or short day key. */
  date: string;
  /** Two-digit day label (`"07"` .. `"31"`). */
  dayLabel: string;
  /** Bucket relative to `today`. */
  bucket: "over" | "today" | "upcoming";
};

type StripEntry = {
  id: string;
  /** Short category badge label shown in the cell. */
  shortLabel: string;
  /** Full accessible name announced for the button. */
  fullLabel: string;
  /** Statutory items render in the top lane; operational items render in the second lane. */
  lane: "statutory" | "operational";
  /** Matching `StripDay.date`, or `null` for undated items. */
  date: string | null;
  /** Severity tone for operational badges. */
  tone?: "over" | "today" | "upcoming" | "undated";
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stripAccessibleName(shortLabel: string, fullLabel: string) {
  const short = shortLabel.trim();
  if (!short) return fullLabel;
  const startsWithToken = new RegExp(`^${escapeRegExp(short)}(?:$|[^\\p{L}\\p{N}])`, "iu");
  return startsWithToken.test(fullLabel.trimStart()) ? fullLabel : `${shortLabel} · ${fullLabel}`;
}

/**
 * Horizontal day-by-lane deadline schedule strip: maps dated and undated worklist items across overdue, today,
 * upcoming, and undated columns in statutory and operational lanes.
 */
export function DeadlineStrip({
  monthLabel,
  days,
  entries,
  meta,
  selectedId,
  onSelect,
}: {
  /** Leading month cell label (for example `"Nov"` or `"11"`). */
  monthLabel: string;
  /** Ordered day columns shown across the strip. */
  days: readonly StripDay[];
  /** Worklist entries placed into `statutory` or `operational` cells. */
  entries: readonly StripEntry[];
  /** Summary text shown beside the strip heading. */
  meta?: ReactNode;
  /** Currently selected worklist item id. */
  selectedId?: string;
  /** Invoked when a badge inside the strip is pressed. */
  onSelect?: (id: string) => void;
}) {
  const overCount = days.filter(d => d.bucket === "over").length;
  const todayCount = days.filter(d => d.bucket === "today").length;
  const upcomingCount = days.filter(d => d.bucket === "upcoming").length;
  const titleText = t("uiWorklist.schedule");

  const renderCell = (lane: "statutory" | "operational", date: string | null) => {
    const matching = entries.filter(entry => entry.lane === lane && entry.date === date);
    if (matching.length === 0) return null;
    return (
      <div className={s.pills}>
        {matching.map(entry => {
          const accessibleName = stripAccessibleName(entry.shortLabel, entry.fullLabel);
          return (
            <button
              key={entry.id}
              type="button"
              className={s.pill}
              data-lane={lane}
              data-tone={entry.tone}
              data-selected={selectedId === entry.id || undefined}
              aria-pressed={onSelect ? selectedId === entry.id : undefined}
              aria-label={accessibleName}
              onClick={() => onSelect?.(entry.id)}
            >
              {entry.shortLabel}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className={s.strip} data-deadline-strip="">
      <PaneHead title={titleText} meta={meta} level={3} />
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Wide day-column schedule must remain keyboard-scrollable (WCAG 2.1.1). */}
      <div className={s.scroller} tabIndex={0} role="region" aria-label={titleText}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col" className={s.laneHead} aria-label={monthLabel} />
              {overCount > 0 ? (
                <th scope="colgroup" colSpan={overCount} className={s.bandOver}>
                  {t("uiWorklist.overdue")}
                </th>
              ) : null}
              {todayCount > 0 ? (
                <th scope="colgroup" colSpan={todayCount} className={s.bandToday}>
                  {t("uiWorklist.today")}
                </th>
              ) : null}
              {upcomingCount > 0 ? (
                <th scope="colgroup" colSpan={upcomingCount} className={s.bandUpcoming}>
                  {t("uiWorklist.upcoming")}
                </th>
              ) : null}
              <th scope="col" className={`${s.bandUpcoming} ${s.undatedCol}`}>
                {t("uiWorklist.undated")}
              </th>
            </tr>
            <tr>
              <th scope="col" className={s.laneHead}>
                {monthLabel}
              </th>
              {days.map(day => (
                <th key={day.date} scope="col" className={s.dayCell} data-today={day.bucket === "today" || undefined}>
                  {day.dayLabel}
                </th>
              ))}
              <th scope="col" className={`${s.dayCell} ${s.undatedCol}`}>
                {t("uiWorklist.undated")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className={s.laneHead}>
                {t("uiWorklist.statutoryLane")}
              </th>
              {days.map(day => (
                <td key={day.date}>{renderCell("statutory", day.date)}</td>
              ))}
              <td className={s.undatedCol}>{renderCell("statutory", null)}</td>
            </tr>
            <tr>
              <th scope="row" className={s.laneHead}>
                {t("uiWorklist.operationalLane")}
              </th>
              {days.map(day => (
                <td key={day.date}>{renderCell("operational", day.date)}</td>
              ))}
              <td className={s.undatedCol}>{renderCell("operational", null)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
