import type { ReactNode } from "react";
import s from "./record.module.css";

/** A dated item on the spine: plan (planned), fix (correction), rev (personnel action/change), new (first entry), end (ended). */
export type SpineItem = { key: string; tone: "plan" | "fix" | "rev" | "new" | "end"; when: ReactNode; what: ReactNode; meta?: ReactNode };

/**
 * "now + history": what holds today, then every dated fact newest first. Sticky beside the record so the history is
 * always one glance away from the field being read.
 */
export function Spine({ title, tools, now, nowKey, next, items, foot, empty }: { title: string; tools?: ReactNode; now: ReactNode; nowKey: ReactNode; next?: ReactNode; items: SpineItem[]; foot?: ReactNode; empty?: ReactNode }) {
  return (
    <aside className={s.spine} aria-label={title}>
      <div className={s.spineHead}>
        <h2>{title}</h2>
        {tools}
      </div>
      <div className={s.spineBody}>
        <div className={s.now}>
          <div className={s.nowKey}>{nowKey}</div>
          {now}
        </div>
        {next}
        {items.length === 0 && empty}
        <ol className={s.items}>
          {items.map((x) => (
            <li key={x.key} className={s.sp} data-t={x.tone}>
              <span className={s.dot} aria-hidden />
              <div>
                <div className={s.when}>{x.when}</div>
                <div className={s.what}>{x.what}</div>
                {x.meta && <div className={s.spMeta}>{x.meta}</div>}
              </div>
            </li>
          ))}
        </ol>
        {foot && <div className={s.spineFoot}>{foot}</div>}
      </div>
    </aside>
  );
}
