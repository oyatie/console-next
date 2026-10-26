import type { ReactNode } from "react";
import type { LaneItem } from "./timeline-lanes";
import type { TimelineState } from "./states";
import s from "./timeline-lanes.module.css";

/** The same date gutter, focus target and body for legacy ribbons and lifecycle lines. */
export function TimelineRow({ id, date, title, state, detail, meta, verbs, tone, struck, highlight, lifecycle, children }: Omit<LaneItem, "key"> & { lifecycle?: TimelineState; children?: ReactNode }) {
  return <li id={id} tabIndex={id ? -1 : undefined} className={s.item}
    data-highlight={highlight || undefined} data-struck={struck || undefined} data-state={lifecycle}>
    <div className={`${s.date} num`}>{date}</div>
    <span className={s.dot} data-tone={tone ?? "neutral"} aria-hidden="true" />
    <div className={s.body}>
      <div className={s.title}><div className={s.text}>{title}</div>{state}</div>
      {detail != null && <div className={s.detail}>{detail}</div>}
      {meta != null && <div className={s.meta}>{meta}</div>}
      {children}
      {verbs != null && <div className={s.verbs}>{verbs}</div>}
    </div>
  </li>;
}
