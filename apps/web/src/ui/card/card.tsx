import { useId, type ReactNode } from "react";
import s from "./card.module.css";
import { shown } from "../shown";

/**
 * A titled surface on a page (kit .card + .card__h): the title (h2 unless `level` says otherwise) with its count or
 * status in `meta` and its tools on the right, then the body. `flush` drops the body's padding for a table or a
 * list that runs edge to edge. A card without a title is a plain surface (`title` omitted). Cards hold a section of
 * a page; a list of records is a table inside one card, never a card per record (design-language §12).
 * `look`: `outline` is a box inside a sheet, panel or section (no shadow: it is not lifted off the page); `dashed` a
 * proposal or a value not recorded yet; `muted` a quoted record (a log line, what the other writer saved).
 */
export function Card({ title, titleId, label, meta, tools, level = 2, flush, look, id, loading, density, children }: {
  title?: ReactNode;
  /** The title's id, for a screen that moves focus to it (the heading takes focus, never a tab stop). */
  titleId?: string;
  /** The region's name when the card has no visible title (a list whose count is its name). */
  label?: string;
  meta?: ReactNode;
  tools?: ReactNode;
  level?: 2 | 3;
  flush?: boolean;
  look?: "outline" | "dashed" | "muted";
  id?: string;
  loading?: boolean;
  density?: "dense" | "default";
  children?: ReactNode;
}) {
  const autoId = useId();
  const headId = titleId ?? autoId;
  const H = level === 3 ? "h3" : "h2";
  return (
    <section id={id} className={s.card} data-look={look} data-density={density} aria-busy={loading || undefined} aria-labelledby={shown(title) ? headId : undefined} aria-label={shown(title) ? undefined : label}>
      {(shown(title) || shown(tools)) && (
        <div className={s.head}>
          {shown(title) && <H id={headId} className={s.title} tabIndex={-1}>{title}</H>}
          {shown(meta) && <span className={s.meta}>{meta}</span>}
          <span className={s.grow} />
          {shown(tools) && <div className={s.tools}>{tools}</div>}
        </div>
      )}
      {loading ? (
        <div className={s.loading} role="status">
          <div className={s.skeleton} />
        </div>
      ) : (
        shown(children) && <div className={s.body} data-flush={flush || undefined}>{children}</div>
      )}
    </section>
  );
}
