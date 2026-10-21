import type { ReactNode } from "react";
import s from "./entity-create.module.css";

/**
 * One certificate item, carrying the number printed beside it on the certificate so a clerk finds the box. The
 * number is a visual aid; the field's own label names it for assistive tech.
 */
export function Item({ no, span, children }: { no: number; span?: boolean; children: ReactNode }) {
  return (
    <div className={s.item} data-span={span || undefined}>
      <span className={s.no} aria-hidden>{no}</span>
      <div className={s.itemBody}>{children}</div>
    </div>
  );
}
