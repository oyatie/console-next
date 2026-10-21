import type { ReactNode } from "react";
import s from "./card.module.css";

/**
 * The head of a section inside a card, panel or sheet (kit .sec__h): a small label-tracked title followed by a rule,
 * with an optional tool at the end (edit, show all). h3 unless `level` says otherwise; `id` lets the section's
 * region point at it (aria-labelledby).
 */
export function SectionHead({ children, tools, level = 3, id }: { children: ReactNode; tools?: ReactNode; level?: 2 | 3 | 4; id?: string }) {
  const H = level === 2 ? "h2" : level === 4 ? "h4" : "h3";
  return (
    <div className={s.sectionHead}>
      <H id={id} className={s.sectionTitle}>{children}</H>
      <span className={s.rule} />
      {tools}
    </div>
  );
}
