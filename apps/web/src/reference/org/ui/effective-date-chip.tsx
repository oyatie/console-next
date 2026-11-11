// SPDX-License-Identifier: LicenseRef-Proprietary
import { CalendarDays } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { isDate } from "../../../ui/date/days";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { dayAllowed } from "../api";

export function EffectiveDateChip({ setup, today, value, onChange }: { setup: boolean; today: string; value: string; onChange: (value: string) => void }) {
  const text = `${t("orgUnit.gov.date")} · ${value === today || !isDate(value) ? t("asof.today") : fmtDate(value)}`;
  const range = setup ? { max: today, maxReason: t("orgUnit.gov.setupPast") } : { min: today };
  return (
    <PopoverButton chip label={text} title={t("orgUnit.gov.date")} trigger={<><CalendarDays size={14} aria-hidden />{text}</>}>
      {(close) => <div className="row"><DateField label={t("orgUnit.gov.date")} required value={value} onChange={(d) => { onChange(d); if (dayAllowed(setup, today, d)) close(); }} today={today} {...range} /><Button onClick={() => { onChange(today); close(); }}>{t("asof.today")}</Button></div>}
    </PopoverButton>
  );
}
