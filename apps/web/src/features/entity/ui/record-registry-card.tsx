import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { DIRECTOR_ROLE, label, REPRESENTATION } from "../../../lib/labels";
import { FactRow } from "./record-fact-row";
import { entityFields } from "./record-entity-fields";
import type { Act } from "./record-revise-sheet";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * registry and entity basics (spec S3): what the corporate registry extract says, with incorporation date as correct-only, and the items never asked
 * named with their basis so a reviewer sees they were left out on purpose. For a business without a registry it
 * holds only representation mode and main phone.
 */
export function RegistryCard({ e, act }: { e: LegalEntity; act: Act }) {
  const c = e.current;
  const f = entityFields(e);
  const corp = e.biz_kind === "CORPORATION";
  const fix = { kind: "fix" as const };
  return (
    <section className="card" aria-labelledby="registry-title">
      <div className={s.cardHead}>
        <h2 id="registry-title" className={s.cardTitle}>{t(corp ? "entityRecord.registry.title" : "entityRecord.registry.titleOther")}</h2>
        {corp && <Muted>{t("entityRecord.registry.basis")}</Muted>}
      </div>
      <div className={s.facts}>
        {/* The optional short and English names, each its own row and its own edit. */}
        {/* With a certificate, its item 1 is where the legal name is shown and edited (one row, one place). */}
        {e.registrations.length === 0 && <FactRow label={f.name.label} wide action={{ kind: "fix", onPress: () => act.field(f.name) }}>{c?.name || "—"}</FactRow>}
        <FactRow label={f.displayName.label} action={{ kind: "fix", onPress: () => act.field(f.displayName) }}>{c?.display_name || "—"}</FactRow>
        <FactRow label={f.englishName.label} action={{ kind: "fix", onPress: () => act.field(f.englishName) }}>{c?.english_name || "—"}</FactRow>
        {corp && (
          <FactRow label={t("entityRecord.field.incorporatedOn")} action={{ kind: "cor", onPress: () => act.field(f.incorporatedOn) }}>
            <span className="num">{c?.incorporated_on ? fmtDate(c.incorporated_on) : "—"}</span>
          </FactRow>
        )}
        {corp && <FactRow label={t("entityRecord.field.capital")} action={{ ...fix, onPress: () => act.field(f.capital) }}><span className="num">{f.capital.current}</span></FactRow>}
        {corp && <FactRow label={t("entityRecord.field.fiscalMonth")} action={{ ...fix, onPress: () => act.field(f.fiscalMonth) }}>{f.fiscalMonth.current}</FactRow>}
        <FactRow label={t("entityRecord.field.representationMode")} action={{ ...fix, onPress: () => act.field(f.representatives) }}>{c?.representation_mode ? label(REPRESENTATION, c.representation_mode) : "—"}</FactRow>
        <FactRow label={t("entityRecord.field.mainPhone")} action={{ ...fix, onPress: () => act.field(f.mainPhone) }}><span className="num">{f.mainPhone.current}</span></FactRow>
        {corp && (
          <FactRow label={t("entityRecord.field.directors")} action={c?.directors ? { ...fix, onPress: () => act.field(f.directors) } : null}>
            {c?.directors == null ? t("entity.field.restricted") : c.directors.length === 0 ? "—" : c.directors.map((d, i) => (
              <span key={i} className={s.line}>{label(DIRECTOR_ROLE, d.role)} {d.name}{d.appointed_on && <span className={s.sub}> {t("entityRecord.registry.appointed", { date: fmtDate(d.appointed_on) })}</span>}</span>
            ))}
          </FactRow>
        )}
        <FactRow label={t("entityRecord.registry.notCollected")}>
          <span className={s.line}><span className={s.sub}>{t("entityRecord.registry.noRrn")}</span></span>
          <span className={s.line}><small className={s.sub}>{t("entityRecord.registry.noRrnBasis")}</small></span>
          <span className={s.line}><span className={s.sub}>{t("entityRecord.registry.noAddress")}</span></span>
        </FactRow>
        {/* company-05: the number a founding recorded, while no certificate shows it; last, so it never moves the facts above. */}
        {corp && e.registrations.length === 0 && <FactRow label={t("entityRecord.field.crn")}><span className="num">{e.crn?.display ?? "—"}</span></FactRow>}
      </div>
    </section>
  );
}
