// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { DateField } from "../../../ui/date/date-field";
import { datePresets } from "../../../ui/date/date-text";

/** Operating placements use an explicitly chosen lifecycle date, including reservations. */
export function UnplacedWhen({ today, value, onChange, onInvalid }: {
  today: string;
  value: string;
  onChange: (date: string) => void;
  onInvalid: (invalid: boolean) => void;
}) {
  return <DateField label={t("lifecycle.date")} required today={today} value={value} onChange={onChange} onInvalid={onInvalid} presets={datePresets(today, ["today", "nextMonday", "nextMonthFirst"])} />;
}
