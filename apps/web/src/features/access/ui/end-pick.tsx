import { useId, useState } from "react";
import { t } from "@console/i18n";
import { ToggleButton } from "../../../ui/button/button";
import { DateInput } from "../../../ui/date/date-input";
import { endPresets } from "../domain/grants";
import s from "./access.module.css";

/**
 * The last day of a grant (mockup M4, design §9.2): 3-month, 6-month and 1-year chips, or a picked date for any later day. An explicit
 * grant always ends (no open end); renewal is a new decision. Nothing is preselected. `value` is the last day it counts.
 */
export function EndPick({ value, onChange, today, error, hideLabel = false }: {
  value: string | null;
  onChange: (day: string | null) => void;
  today: string;
  error?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  const presets = endPresets(today);
  const preset = presets.some((p) => p.date === value);
  // The date box is open while a day is being picked; once it is left with a day, the chip shows that day (mockup M4).
  const [typing, setTyping] = useState(false);
  const custom = typing || (value != null && !preset);
  return (
    <div className={s.endPick} role="group" aria-labelledby={`${id}-l`} aria-describedby={error ? `${id}-e` : undefined}>
      <span id={`${id}-l`} className={hideLabel ? "sr-only" : "field__label"}>{t("access.grant.end")}</span>
      <div className={s.chips}>
        {presets.map((p) => (
          <ToggleButton key={p.id} size="sm" pressed={value === p.date} aria-label={t("access.grant.end.preset", { label: t(`access.grant.end.${p.id}`), date: p.date })} onClick={() => (setTyping(false), onChange(p.date))}>
            {t(`access.grant.end.${p.id}`)}
          </ToggleButton>
        ))}
        <ToggleButton size="sm" pressed={custom} onClick={() => (setTyping(true), preset && onChange(null))}>{value && !preset ? value : t("access.grant.end.pick")}</ToggleButton>
      </div>
      {typing && (
        <DateInput label={t("access.grant.end.date")} className={s.endDate} min={today} value={value && !preset ? value : ""} onChange={(date) => onChange(date || null)} onBlur={(e) => e.currentTarget.value && setTyping(false)} />
      )}
      {error && <span id={`${id}-e`} className="field__error">{error}</span>}
    </div>
  );
}
