import type { ReactNode } from "react";
import s from "./timeline-lanes.module.css";
import { TimelineRow } from "./timeline-row";

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

/** One record on the ribbon. `date` is the business date as shown in the gutter (preformatted, never wrapping). */
export type LaneItem = {
  key: string;
  /** DOM id: the row takes focus by it (after a commit, or from a link to it). */
  id?: string;
  date: string;
  /** The type dot's colour; never the only signal, the title names the act. */
  tone?: Tone;
  title: ReactNode;
  /** A state chip after the title (scheduled, failed, withdrawn). */
  state?: ReactNode;
  detail?: ReactNode;
  /** Who recorded it and when. */
  meta?: ReactNode;
  /** What the record still admits (withdraw, change, record again). */
  verbs?: ReactNode;
  /** Withdrawn: struck through, kept in place. */
  struck?: boolean;
  /** The record a commit just added or changed (static marker; no motion). */
  highlight?: boolean;
};

/**
 * An entity's records on one effective-date ribbon (entity-lifespan-timeline, scheduled-lane-cancellable):
 * the scheduled lane above a labelled "today" rule, the past below, both newest first. Lane titles are
 * headings so a screen-reader user can jump between them. Rows with an id can take focus (tabIndex -1).
 */
export function TimelineLanes({ upcoming, past, labels, level = 3 }: {
  upcoming: readonly LaneItem[];
  past: readonly LaneItem[];
  labels: { upcoming: string; today: string; past: string };
  /** Heading level of the lane titles (one below the section heading). */
  level?: 3 | 4;
}) {
  const H = `h${level}` as const;
  return (
    <div className={s.lanes}>
      {upcoming.length > 0 && (
        <>
          <H className={s.lane}>{labels.upcoming}</H>
          <Items items={upcoming} />
        </>
      )}
      <div role="separator" aria-label={labels.today} className={s.today}>
        <span aria-hidden="true">{labels.today}</span>
      </div>
      {past.length > 0 && (
        <>
          <H className={s.lane}>{labels.past}</H>
          <Items items={past} />
        </>
      )}
    </div>
  );
}

function Items({ items }: { items: readonly LaneItem[] }) {
  return (
    <ol className={s.list}>
      {items.map(({ key, ...item }) => <TimelineRow key={key} {...item} />)}
    </ol>
  );
}
