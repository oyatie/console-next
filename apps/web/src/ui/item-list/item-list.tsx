import type { ReactNode } from "react";
import s from "./item-list.module.css";

/** One row: a leading mark (an icon, an Avatar), the text, and a quiet value at the end; `tone` colours the mark only. */
export type Item = { key: string; mark?: ReactNode; text: ReactNode; end?: ReactNode; tone?: "ok" | "warn" | "danger" };

/**
 * A short list inside a card or panel (kit .mlist): compact rows split by hairlines, the end value right-aligned. For
 * a checklist, the people of a unit, a document's fields. More than a screenful, or anything sortable, is a Table.
 */
export function ItemList({ items, label }: { items: readonly Item[]; label?: string }) {
  return (
    <ul className={s.list} aria-label={label}>
      {items.map((i) => (
        <li key={i.key} className={s.item} data-tone={i.tone}>
          {i.mark != null && <span className={s.mark}>{i.mark}</span>}
          <span className={s.text}>{i.text}</span>
          {i.end != null && <span className={s.end}>{i.end}</span>}
        </li>
      ))}
    </ul>
  );
}
