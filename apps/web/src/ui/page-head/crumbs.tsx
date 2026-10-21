import { Fragment, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import s from "./page-head.module.css";

/**
 * Where a page or panel sits (kit .crumbs): the ancestors as the caller's links, then the `current` place as text
 * (aria-current="page"). The separators are drawn, never read.
 */
export function Crumbs({ items, current }: { items: readonly ReactNode[]; current?: ReactNode }) {
  const all = current == null ? items : [...items, <span key="current" aria-current="page" className={s.current}>{current}</span>];
  return (
    <nav aria-label={t("uiCrumbs.label")} className={s.crumbs}>
      <ol className={s.trail}>
        {all.map((node, i) => (
          <Fragment key={i}>
            {i > 0 && <li aria-hidden className={s.sep}><ChevronRight size={14} /></li>}
            <li className={s.crumb}>{node}</li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
