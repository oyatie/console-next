import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { Kbd } from "../../../ui/record/record-section";
import { Band } from "../../../ui/band/band";
import s from "./roster.module.css";

/** The roster's key strip (E1): where the list stands, and the keys that work in it (only those). */
export function RosterFoot({ shown, total, changed }: { shown: number; total?: number; changed?: ReactNode }) {
  return (
    <Band edge="none" className={s.foot} role="note" aria-label={t("roster.foot.label")}>
      {/* The count's place is held before it lands, and a late "list changed" sits after the text: nothing slides. */}
      <span className={s.footCount}>{total !== undefined && <b className={s.footRange}>{t("roster.foot.range", { shown, total })}</b>}</span>
      {changed}
      <span className="grow" />
      <span className={s.key}><Kbd k="J" /><Kbd k="K" /> {t("roster.foot.move")}</span>
      <span className={s.key}><Kbd k="Enter" /> {t("roster.foot.open")}</span>
      <span className={s.key}><Kbd k="O" /> {t("roster.foot.card")}</span>
      <span className={s.key}><Kbd k="/" /> {t("roster.foot.find")}</span>
    </Band>
  );
}
