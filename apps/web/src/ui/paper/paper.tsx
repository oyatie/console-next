import type { ReactNode } from "react";
import s from "./paper.module.css";

/**
 * A printed form drawn on screen (a personnel record, an employee register, a certificate preview): the paper itself stays light in dark mode.
 * `size="a4"` is a page, `"wide"` a landscape register, none a small preview inside a sheet. `watermark` is drawn as
 * pseudo-content (no text to read or contrast-check) and never printed. `PaperWell` is the grey well around a page.
 */
export function Paper({ size, label, watermark, children }: { size?: "a4" | "wide"; label: string; watermark?: string; children: ReactNode }) {
  return (
    <article className={s.paper} data-size={size} data-paper aria-label={label}>
      {watermark && <span className={s.wm} aria-hidden data-wm={watermark} />}
      {children}
    </article>
  );
}

export const PaperWell = ({ children }: { children: ReactNode }) => <div className={s.well}>{children}</div>;

/** The form's title (spaced, as printed) and what stands beside it on the top line. */
export const PaperHead = ({ title, children }: { title: ReactNode; children?: ReactNode }) => (
  <div className={s.top}><b className={s.title}>{title}</b>{children}</div>
);

/** The line under the form: when and why it was printed. */
export const PaperFoot = ({ children }: { children: ReactNode }) => <span className={s.foot}>{children}</span>;

/** The identity block: the photo box beside the facts. */
export const PaperId = ({ photo, children }: { photo: ReactNode; children: ReactNode }) => (
  <div className={s.id}><span className={s.photo} aria-hidden>{photo}</span>{children}</div>
);
