import { t } from "@console/i18n";
import { Avatar } from "../../../ui/avatar/avatar";
import { Band } from "../../../ui/band/band";
import { BoneShape } from "../../../ui/skeleton/skeleton";
import { TabNav } from "../../../ui/tabs/tabs";
import s from "./card.module.css";

/**
 * The personnel card while it loads (E12-loading): the head band and the record's two columns in outline, shown only after a
 * short delay (CSS) so a fast load never flashes it; the real card then fills the same geometry.
 */
export function CardSkeleton() {
  return (
    <div className={s.page} data-read-layout="record" role="status" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <Band className={`${s.head} ${s.late}`} aria-hidden>
        <div className={s.top}><BoneShape bone="crumb" /></div>
        <div className={s.hdr}><Avatar size="lg" name="" /><div className={s.who}><BoneShape bone="title" /><BoneShape bone="line" /><BoneShape bone="short" /></div></div>
        <TabNav label={t("common.loading")}><BoneShape bone="line" /></TabNav>
      </Band>
      <div className={`${s.rec} ${s.late}`} aria-hidden>
        <div className={s.main}>{[0, 1, 2].map((i) => <BoneShape key={i} bone="block" />)}</div>
        <BoneShape bone="spine" />
      </div>
    </div>
  );
}
