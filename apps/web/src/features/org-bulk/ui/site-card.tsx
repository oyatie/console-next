import { t } from "@console/i18n";
import { AddressField } from "../../../ui/address-field/address-field";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { todayKst } from "../../../lib/pure/today";
import { useAddressSearch } from "../../../reference/entity/ui/use-address-search";
import { openQuestions, type SiteAnswers } from "../domain/ops";
import s from "./bulk.module.css";

/**
 * The questions a new workplace answers before any commit (S7 paste and import, R10, R12): withholding tax and social insurance with
 * nothing preselected, the main workplace when its numbers are shared, and the address and opening date the server
 * still requires of a workplace without a certificate.
 */
export function SiteCard({ name, value, onChange, mains }: {
  name: string;
  value: SiteAnswers;
  onChange: (v: SiteAnswers) => void;
  /** The same legal entity's existing workplace that can hold the shared numbers. */
  mains: readonly { id: string; name: string }[];
}) {
  const set = <K extends keyof SiteAnswers>(k: K, v: SiteAnswers[K]) => onChange({ ...value, [k]: v });
  const addr = useAddressSearch();
  const open = openQuestions(value);
  return (
    <section className={`card ${s.card}`} aria-label={t("orgBulk.site.title", { name })}>
      <h2 className={s.cardHead}>
        {t("orgBulk.site.title", { name })}
        <Chip tone={open ? "warn" : "ok"}>{open ? t("orgBulk.site.open", { count: open }) : t("orgBulk.site.done")}</Chip>
      </h2>
      <ChoiceField
        label={t("orgBulk.site.withholding")}
        required
        options={(["HEAD", "OWN"] as const).map((v) => ({ value: v, label: t(`orgBulk.site.withholding.${v}`) }))}
        value={value.withholding}
        onChange={(v) => set("withholding", v as SiteAnswers["withholding"])}
      />
      <ChoiceField
        label={t("orgBulk.site.insurance")}
        required
        options={(["LATER", "MAIN", "NONE"] as const).map((v) => ({ value: v, label: t(`orgBulk.site.insurance.${v}`) }))}
        value={value.insurance}
        onChange={(v) => onChange({ ...value, insurance: v as SiteAnswers["insurance"], mainWorkplaceId: null })}
      />
      <DisabledReason control={(p) => <Button {...p}>{t("orgBulk.site.insurance.PER")}</Button>} reason={t("orgBulk.site.insurance.perLater")} layout="inline" />
      {value.insurance === "MAIN" &&
        (mains.length ? (
          <ChoiceField
            label={t("orgBulk.site.main")}
            required
            options={mains.map((m) => ({ value: m.id, label: m.name }))}
            value={value.mainWorkplaceId}
            onChange={(v) => set("mainWorkplaceId", v)}
          />
        ) : (
          <p className={s.danger}>{t("orgBulk.site.noMain")}</p>
        ))}
      <AddressField
        label={t("orgBulk.site.address")}
        required
        value={value.address}
        onChange={(v) => set("address", v && addr.withCodes(v))}
        query={addr.query}
        onQueryChange={addr.setQuery}
        hits={addr.hits}
        loading={addr.loading}
        problem={addr.problem}
      />
      <DateField label={t("orgBulk.site.openedOn")} required value={value.openedOn} onChange={(v) => set("openedOn", v)} today={todayKst()} />
    </section>
  );
}
