import { Fragment, type ReactNode, type Ref } from "react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Field } from "../field/field";
import { inBounds, isDate, nextWeekday } from "./days";
import { DateInput } from "./date-input";
import s from "./date.module.css";

export { DateInput } from "./date-input";
export type DatePreset = { label: string; date: string };

/** A business date (components.html §5): keyboard entry and an accessible calendar, with one shared set of bounds and presets. */
export function DateField({ label, required, value, onChange, today, min: floor, minFrom, max, disabledDates, basis, note, echo, presets, suggestWeekday = false, error, remedy, inputRef, showErrors = true }: {
  label: string;
  required: boolean;
  /** `YYYY-MM-DD`, or "" while empty. */
  value: string;
  onChange: (value: string) => void;
  today: string;
  min?: string;
  minFrom?: { date: string; reason: ReactNode };
  max?: string;
  disabledDates?: readonly string[];
  basis?: ReactNode;
  note?: ReactNode;
  echo?: ReactNode;
  presets?: readonly DatePreset[];
  suggestWeekday?: boolean;
  error?: ReactNode;
  remedy?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  showErrors?: boolean;
}) {
  const min = minFrom && (!floor || minFrom.date > floor) ? minFrom.date : floor;
  const why = minFrom && min === minFrom.date ? minFrom.reason : undefined;
  const filled = isDate(value);
  const disabled = new Set((disabledDates ?? []).filter(isDate));
  const out = filled && !inBounds(value, min, max);
  const unavailable = filled && (out || disabled.has(value));
  const next = filled && suggestWeekday ? nextWeekday(value) : null;
  const shown = error ?? (unavailable ? (out && why != null && min !== undefined && value < min ? why : out ? t("uiDate.outOfRange") : t("uiDate.disabled")) : undefined);
  const details = [
    filled ? echo : null,
    basis,
    why,
    !why && presets?.some((pr) => !inBounds(pr.date, min, max)) ? t("uiDate.outOfRange") : null,
    disabled.size > 0 ? t("uiDate.disabled") : null,
  ].filter((detail) => detail != null);
  return (
    <div className={s.date}>
      <Field label={label} required={required} tag={note} hint={details.length > 0 ? details.map((detail, i) => <Fragment key={i}>{i > 0 && " · "}{detail}</Fragment>) : undefined} error={shown == null ? undefined : <>{shown}{remedy != null && <span className={s.remedy}>{remedy}</span>}</>}>
        {(p) => (
          <div className={s.row}>
            {presets && presets.length > 0 && (
              <div role="group" aria-label={t("uiDate.presets", { label })} className={s.presets}>
                {presets.map((pr) => {
                  const off = !inBounds(pr.date, min, max) || disabled.has(pr.date);
                  return (
                    <button
                      key={pr.date}
                      type="button"
                      className={s.preset}
                      aria-pressed={value === pr.date}
                      aria-disabled={off || undefined}
                      aria-describedby={off ? p["aria-describedby"] : undefined}
                      onClick={() => !off && onChange(pr.date)}
                    >
                      {pr.label}
                      <span className={s.resolved}>{fmtDate(pr.date, { weekday: "short" })}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <DateInput
              id={p.id}
              value={value}
              onChange={onChange}
              required={p.required}
              today={today}
              min={min}
              minReason={why}
              max={max}
              disabledDates={disabledDates}
              aria-describedby={p["aria-describedby"]}
              aria-invalid={p["aria-invalid"]}
              inputRef={inputRef}
              showErrors={showErrors && (shown == null || !filled)}
            />
          </div>
        )}
      </Field>
      {next && (
        <p className={s.suggest}>
          {t("uiDate.weekend", { day: fmtDate(value, { weekday: "long" }), next: fmtDate(next, { weekday: "short" }) })}
          <button type="button" className="link" onClick={() => onChange(next)}>{t("uiDate.weekend.use", { next: fmtDate(next, { weekday: "short" }) })}</button>
        </p>
      )}
    </div>
  );
}
