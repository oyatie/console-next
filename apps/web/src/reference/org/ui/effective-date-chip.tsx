// SPDX-License-Identifier: LicenseRef-Proprietary
import { CalendarDays } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DateField } from "../../../ui/date/date-field";
import { isDate } from "../../../ui/date/days";
import { PopoverButton } from "../../../ui/popover/popover-button";

export function EffectiveDateChip({ setup, today, value, onChange }: { setup: boolean; today: string; value: string; onChange: (value: string) => void }) {
  if (setup) return <Chip>{t("orgUnit.gov.date")} · {t("asof.today")}</Chip>;
  const text = `${t("orgUnit.gov.date")} · ${value === today || !isDate(value) ? t("asof.today") : fmtDate(value)}`;
  return (
    <PopoverButton chip label={text} title={t("orgUnit.gov.date")} trigger={<><CalendarDays size={14} aria-hidden />{text}</>}>
      {(close) => <div className="row"><DateField label={t("orgUnit.gov.date")} required value={value} onChange={(d) => { onChange(d); if (isDate(d) && d >= today) close(); }} today={today} min={today} /><Button onClick={() => { onChange(today); close(); }}>{t("asof.today")}</Button></div>}
    </PopoverButton>
  );
}
