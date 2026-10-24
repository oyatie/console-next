import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { FactRow } from "./record-fact-row";
import { RegularHeadcount } from "./regular-headcount";
import { entityFields } from "./record-entity-fields";
import type { Act } from "./record-revise-sheet";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * VAT, employment insurance and workers (spec S3): the derived filing unit with its basis, main industry, priority-support status, and
 * regular-worker count, which is held until its method is released (BW-35), so only the live roster count shows, never a
 * made-up number (R13: headcount and regular-worker count differ).
 */
export function VatCard({ e, act }: { e: LegalEntity; act: Act }) {
  const c = e.current;
  const f = entityFields(e);
  const rw = e.regular_workers;
  return (
    <section className="card" aria-labelledby="vat-title">
      <div className={s.cardHead}><h2 id="vat-title" className={s.cardTitle}>{t("entityRecord.vat.title")}</h2></div>
      <div className={s.facts}>
        <FactRow label={t("entityRecord.vat.unit")}>
          {c?.vat_unit_mode ? t(`entity.vat.${c.vat_unit_mode}`) : "—"}
          {c?.vat_unit_mode_basis && <span className={s.sub}> {t(`entity.basis.${c.vat_unit_mode_basis}`)}</span>}
        </FactRow>
        <FactRow label={t("entityRecord.vat.mainKsic")} action={f.mainKsic ? { kind: "fix", onPress: () => act.field(f.mainKsic!) } : null}>
          {c?.main_ksic ? `KSIC ${c.main_ksic.code} · ${c.main_ksic.label}` : <Muted>{t("entityRecord.vat.ksicPending")}</Muted>}
        </FactRow>
        <FactRow label={t("entityRecord.vat.priority")}>
          {c?.priority_support ? t(c.priority_support === "YES" ? "entityRecord.vat.priorityYes" : "entityRecord.vat.priorityNo") : "—"}
          <span className={s.sub}> {t("entityRecord.vat.priorityBasis")}</span>
        </FactRow>
        <FactRow label={t("entityRecord.field.largeGroup")} action={{ kind: "fix", onPress: () => act.field(f.largeGroup) }}>{f.largeGroup.current}</FactRow>
        <div className={s.wideCell}><RegularHeadcount r={rw} asOf={e.as_of} /></div>
      </div>
    </section>
  );
}
