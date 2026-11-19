import type { LaneItem } from "./timeline-lanes";
import s from "./timeline-lanes.module.css";

/** One timeline row: the date gutter, the focus target and the body. */
export function TimelineRow({ id, date, title, state, detail, meta, verbs, tone, struck, highlight }: Omit<LaneItem, "key">) {
  return <li id={id} tabIndex={id ? -1 : undefined} className={s.item}
    data-highlight={highlight || undefined} data-struck={struck || undefined}>
    <div className={`${s.date} num`}>{date}</div>
    <span className={s.dot} data-tone={tone ?? "neutral"} aria-hidden="true" />
    <div className={s.body}>
      <div className={s.title}><div className={s.text}>{title}</div>{state}</div>
      {detail != null && <div className={s.detail}>{detail}</div>}
      {meta != null && <div className={s.meta}>{meta}</div>}
      {verbs != null && <div className={s.verbs}>{verbs}</div>}
    </div>
  </li>;
}
