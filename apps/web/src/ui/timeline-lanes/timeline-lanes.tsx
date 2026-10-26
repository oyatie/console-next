import { useState, type ReactNode } from "react";
import { Pager } from "../pager";
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

type TimelineLanesProps =
  | {
      items: readonly LaneItem[];
      upcoming?: never;
      past?: never;
      labels?: never;
      level?: 3 | 4;
      loading?: boolean;
      empty?: ReactNode;
      error?: ReactNode;
      density?: "dense" | "default";
      pageSize?: number;
    }
  | {
      items?: never;
      upcoming: readonly LaneItem[];
      past: readonly LaneItem[];
      labels: { upcoming: string; today: string; past: string };
      level?: 3 | 4;
      loading?: boolean;
      empty?: ReactNode;
      error?: ReactNode;
      density?: "dense" | "default";
      pageSize?: number;
    };

/**
 * An entity's records on one effective-date ribbon (entity-lifespan-timeline, scheduled-lane-cancellable):
 * the scheduled lane above a labelled "today" rule, the past below, both newest first. Lane titles are
 * headings so a screen-reader user can jump between them. Rows with an id can take focus (tabIndex -1).
 * Supports single-lane mode when `items` is given directly.
 */
export function TimelineLanes(props: TimelineLanesProps) {
  const { loading, empty, error, density, pageSize = 50, level = 3 } = props;

  if (error) {
    return (
      <div className={s.lanes} data-state="error" role="alert">
        <div className={s.error}>{error}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={s.lanes} aria-busy="true" data-loading="true">
        <div className={s.loading} role="status">
          <div className={s.skeleton} />
        </div>
      </div>
    );
  }

  if (props.items) {
    return <div className={s.lanes} data-density={density}>
      {props.items.length ? <Items items={props.items} pageSize={pageSize} /> : empty != null && <div className={s.empty}>{empty}</div>}
    </div>;
  }

  const { upcoming, past, labels } = props;
  if (upcoming.length === 0 && past.length === 0) {
    return <div className={s.lanes}>{empty != null && <div className={s.empty}>{empty}</div>}</div>;
  }
  const H = `h${level}` as const;
  return (
    <div className={s.lanes} data-density={density}>
      {upcoming.length > 0 && (
        <section aria-label={labels.upcoming}>
          <H className={s.lane}>{labels.upcoming}</H>
          <Items items={upcoming} pageSize={pageSize} />
        </section>
      )}
      <div role="separator" aria-label={labels.today} className={s.today}>
        {labels.today}
      </div>
      {past.length > 0 && (
        <section aria-label={labels.past}>
          <H className={s.lane}>{labels.past}</H>
          <Items items={past} pageSize={pageSize} />
        </section>
      )}
    </div>
  );
}

function Items({ items, pageSize }: { items: readonly LaneItem[]; pageSize: number }) {
  // The first page follows new records; later pages keep their first record and stable row focus.
  const [first, setFirst] = useState<string>();
  const offset = Math.max(0, items.findIndex(item => item.key === first));
  return <>
    <ol className={s.list}>
      {items.slice(offset, offset + pageSize).map(({ key, ...item }) => <TimelineRow key={key} {...item} />)}
    </ol>
    <Pager offset={offset} limit={pageSize} total={items.length} onPage={next => setFirst(next < pageSize ? undefined : items[next]?.key)} />
  </>;
}
