// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { SelectField, type SelectOption } from "../../../ui/select/select-field";

export function ScopePickerConsole({
  compact,
  value,
  allKey,
  allLabel,
  options,
  onChange,
}: {
  compact?: boolean;
  value?: string;
  allKey: string;
  allLabel: string;
  options: SelectOption[];
  onChange: (id: string | undefined) => void;
}) {
  return (
    <SelectField
      label={t("attendanceRecords.scope.label")}
      hideLabel={compact}
      required={false}
      options={options}
      value={value ?? allKey}
      onChange={next => onChange(next === allKey ? undefined : next)}
      placeholder={allLabel}
    />
  );
}
