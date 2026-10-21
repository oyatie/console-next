import type { ReactNode } from "react";
import type { LaneItem } from "./timeline-lanes";
import type { TimelineState } from "./states";
import s from "./timeline-lanes.module.css";

/** The same date gutter, focus target and body for legacy ribbons and lifecycle lines. */
export function TimelineRow({ id, date, title, state, detail, meta, verbs, tone, struck, highlight, lifecycle, children }: Omit<LaneItem, "key"> & { lifecycle?: TimelineState; children?: ReactNode }) {
  return <li id={id} tabIndex={id ? -1 : undefined} className={s.item}
    data-highlight={highlight || undefined} data-struck={struck || undefined} data-state={lifecycle}>
    <span className={`${s.date} num`}>{date}</span>
    <span className={s.dot} data-tone={tone ?? "neutral"} aria-hidden="true" />
    <div className={s.body}>
      <p className={s.title}><span className={s.text}>{title}</span>{state}</p>
      {detail != null && <p className={s.detail}>{detail}</p>}
      {meta != null && <p className={s.meta}>{meta}</p>}
      {children}
      {verbs != null && <div className={s.verbs}>{verbs}</div>}
    </div>
  </li>;
}
