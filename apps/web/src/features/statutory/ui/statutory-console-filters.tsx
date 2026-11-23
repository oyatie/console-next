// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { EXPORT_PURPOSES } from "../../../reference/directory/domain/export";
import { Button, ToggleButton } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { SelectField } from "../../../ui/select/select-field";
import { filingLabel } from "../present";
import s from "./statutory-console.module.css";

const INSURER_OPTIONS = ["ALL", "NPS", "NHIS", "EI", "IACI"] as const;

export function StatutoryFilters({
  tab,
  site,
  workplaceOptions,
  onSiteChange,
  insurer,
  onInsurerChange,
  urgentOnly,
  onToggleUrgent,
  date,
  today,
  onDateChange,
}: {
  tab: "insurance" | "register";
  site?: string;
  workplaceOptions: { id: string; label: string }[];
  onSiteChange: (site?: string) => void;
  insurer: string;
  onInsurerChange: (insurer: string) => void;
  urgentOnly: boolean;
  onToggleUrgent: () => void;
  date: string;
  today: string;
  onDateChange: (d: string) => void;
}) {
  return (
    <div className={s.filterGroup}>
      <div className={s.workplaceField}>
        <SelectField
          label={t("statutory.workplace")}
          required={tab === "register"}
          placeholder={t("statutory.pickWorkplace")}
          value={site ?? (tab === "insurance" ? "all" : null)}
          options={workplaceOptions}
          onChange={(next) => onSiteChange(next === "all" ? undefined : next ?? undefined)}
        />
      </div>
      {tab === "insurance" ? (
        <>
          <div className={s.insurerField}>
            <SelectField
              label={t("statutory.insurerLabel")}
              placeholder={t("statutory.allInsurers")}
              value={insurer}
              options={INSURER_OPTIONS.map((id) => ({ id, label: id === "ALL" ? t("statutory.allInsurers") : filingLabel(id) }))}
              onChange={(next) => onInsurerChange(next ?? "ALL")}
            />
          </div>
          <ToggleButton look="chip" pressed={urgentOnly} size="sm" className={s.nowrap} onClick={onToggleUrgent}>
            {t("statutory.urgentOnly")}
          </ToggleButton>
        </>
      ) : (
        <DateField
          label={t("statutory.asOf")}
          required
          value={date}
          onChange={onDateChange}
          today={today}
          max={today}
          presets={[{ label: t("statutory.today"), date: today }]}
        />
      )}
    </div>
  );
}

export function RegisterExportTools({
  purpose,
  onPurposeChange,
  triedExport,
  pending,
  onExport,
}: {
  purpose: string | null;
  onPurposeChange: (purpose: string) => void;
  triedExport: boolean;
  pending: boolean;
  onExport: (format: "xlsx" | "pdf") => void;
}) {
  return (
    <div className={s.filterGroup}>
      <SelectField
        label={t("statutory.purpose")}
        placeholder={t("statutory.pickPurpose")}
        value={purpose}
        options={EXPORT_PURPOSES.map((p) => ({ id: p, label: t(`roster.export.purpose.${p}`) }))}
        onChange={onPurposeChange}
        error={triedExport && !purpose ? t("roster.export.purpose.pick") : undefined}
      />
      <Button size="sm" className={s.nowrap} onClick={() => onExport("xlsx")} disabled={pending}>{t("statutory.xlsx")}</Button>
      <Button size="sm" className={s.nowrap} onClick={() => onExport("pdf")} disabled={pending}>{t("statutory.pdf")}</Button>
    </div>
  );
}
