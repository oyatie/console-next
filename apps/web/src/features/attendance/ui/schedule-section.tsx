// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import s from "./attendance-console.module.css";

export function ScheduleSection({
  id,
  title,
  meta,
  tools,
  children,
}: {
  id: string;
  title: string;
  meta?: string;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={s.groupSection}>
      <div className={s.scheduleHeader}>
        <div>
          <h3 id={`${id}-h`} className="t-label">{title}</h3>
          {meta ? <bdi className="muted t-xs">{meta}</bdi> : null}
        </div>
        {tools ? <div className={s.scheduleTools}>{tools}</div> : null}
      </div>
      {children}
    </section>
  );
}
