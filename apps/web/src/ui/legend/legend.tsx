import type { ReactNode } from "react";
import s from "./legend.module.css";

/** A swatch's look: the change marks of a structure picture (new · moved · changed · gone) or a plain one. */
export type Swatch = "new" | "mov" | "chg" | "gone" | "sel" | "plain";

/**
 * The key to a picture's marks (kit .legend): a small swatch and its words. The words carry the meaning; the swatch
 * repeats it (WCAG 1.4.1), so a legend never stands in for the text marks on the picture itself.
 */
export function Legend({ items, label }: { items: readonly { swatch: Swatch; text: ReactNode }[]; label?: string }) {
  return (
    <ul className={s.legend} aria-label={label}>
      {items.map((i) => (
        <li key={i.swatch} className={s.item}>
          <i className={s.swatch} data-swatch={i.swatch} aria-hidden />
          {i.text}
        </li>
      ))}
    </ul>
  );
}
