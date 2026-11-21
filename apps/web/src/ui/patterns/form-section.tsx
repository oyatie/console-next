// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import s from "./form.module.css";

/** A full-width rule-divided section inside `FormPattern` (`P7`). */
export function FormSection({ children }: { children: ReactNode }) {
  return <div className={s.section}>{children}</div>;
}

/** A rule-divided operational row list inside a `FormSection`. */
export function FormRowList({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div role="list" aria-label={label} className={s.rowList}>
      {children}
    </div>
  );
}

/** A compact 2-line operational row inside `FormRowList`: primary label + end status chip on line 1, muted secondary detail on line 2. */
export function FormRow({
  primary,
  end,
  secondary,
}: {
  primary: ReactNode;
  end?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div role="listitem" className={s.rowItem}>
      <div className={s.rowTop}>
        <div className={s.rowPrimary}>{primary}</div>
        {end ? <div className={s.rowEnd}>{end}</div> : null}
      </div>
      {secondary ? <div className={s.rowSecondary}>{secondary}</div> : null}
    </div>
  );
}
