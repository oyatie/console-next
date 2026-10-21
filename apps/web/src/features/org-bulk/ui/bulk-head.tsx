import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Network, X } from "lucide-react";
import { t } from "@console/i18n";
import s from "./bulk.module.css";

/** The full-page head of a bulk path (spec D9): crumb, title, then the steps or the place it writes under, and close. */
export function BulkHead({ title, crumb, under, children }: { title: string; crumb?: string; under?: string; children?: ReactNode }) {
  return (
    <header className={s.head}>
      <div className={s.titles}>
        <span className={s.crumb}>
          <Network size={14} aria-hidden /> {t("orgBulk.crumb")} <ChevronRight size={14} aria-hidden /> {crumb}
        </span>
        <h1 className={s.title}>{title}</h1>
      </div>
      {under && <p className={s.under}>{under}</p>}
      {children}
      <Link to="/org" search={{}} className="btn btn--ghost" aria-label={t("orgBulk.close")}><X size={18} aria-hidden /></Link>
    </header>
  );
}
