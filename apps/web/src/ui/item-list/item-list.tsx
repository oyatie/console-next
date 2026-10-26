import type { ReactNode } from "react";
import s from "./item-list.module.css";

/** One row: a leading mark (an icon, an Avatar), the text, and a quiet value at the end; `tone` colours the mark only. */
export type Item = {
  key: string;
  mark?: ReactNode;
  text: ReactNode;
  end?: ReactNode;
  tone?: "ok" | "warn" | "danger";
  onSelect?: () => void;
};

/**
 * A short list inside a card or panel (kit .mlist): compact rows split by hairlines, the end value right-aligned. For
 * a checklist, the people of a unit, a document's fields. More than a screenful, or anything sortable, is a Table.
 */
export function ItemList({
  items,
  label,
  loading,
  empty,
  error,
  density,
}: {
  items: readonly Item[];
  label?: string;
  loading?: boolean;
  empty?: ReactNode;
  error?: ReactNode;
  density?: "dense" | "default";
}) {
  return (
    <ul className={s.list} aria-label={label} data-density={density} aria-busy={loading || undefined}>
      {loading ? (
        <li className={s.loading} role="status">
          <span className={s.skeleton} />
        </li>
      ) : error ? (
        <li className={s.error} role="alert" data-state="error">
          {error}
        </li>
      ) : items.length === 0 ? (
        empty != null && <li className={s.empty}>{empty}</li>
      ) : (
        items.map((i) => {
          const content = (
            <>
              {i.mark != null && <span className={s.mark}>{i.mark}</span>}
              <span className={s.text}>{i.text}</span>
              {i.end != null && <span className={s.end}>{i.end}</span>}
            </>
          );
          return (
            <li key={i.key} className={s.item} data-tone={i.tone}>
              {i.onSelect ? (
                <button type="button" className={s.itemBtn} onClick={i.onSelect}>
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })
      )}
    </ul>
  );
}
