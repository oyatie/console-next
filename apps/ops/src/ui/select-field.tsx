// SPDX-License-Identifier: LicenseRef-Proprietary
import { ChevronDown } from "lucide-react";
import s from "./select-field.module.css";

export type SelectOption = {
  value: string;
  label: string;
};

export function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
}) {
  return (
    <span className={s.wrap}>
      <select
        id={id}
        className={s.select}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className={s.chevron} aria-hidden="true" />
    </span>
  );
}
