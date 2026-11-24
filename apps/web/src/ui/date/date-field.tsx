// SPDX-License-Identifier: LicenseRef-Proprietary
import { Fragment, type ReactNode, type Ref } from "react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Field } from "../field/field";
import { inBounds, isDate, nextWeekday } from "./days";
import { DateInput } from "./date-input";
import s from "./date.module.css";

export { DateInput } from "./date-input";
export type DatePreset = { label: string; date: string; disabledReason?: string };

/** A business date (components.html §5): keyboard entry and an accessible calendar, with one shared set of bounds and presets. */
export function DateField({ label, required, value, onChange, onInvalid, today, min: floor, minFrom, minReason, max, maxReason, disabledDates, basis, note, echo, presets, suggestWeekday = false, error, remedy, inputRef, showErrors = true, displayFormat = "default", disabled: fieldDisabled }: {
  label: string;
  required: boolean | null;
  /** Whether the typed text was refused (see DateInput): an optional field's form holds its save on it. */
  onInvalid?: (invalid: boolean) => void;
  /** `YYYY-MM-DD`, or "" while empty. */
  value: string;
  onChange: (value: string) => void;
  today: string;
  min?: string;
  minFrom?: { date: string; reason: ReactNode };
  /** Why a date before `min` is refused (the caller's rule), in the error only; `minFrom` also states it beforehand. */
  minReason?: ReactNode;
  max?: string;
  /** Why a date after `max` is refused (e.g. that a date after today cannot be recorded), shown in place of the generic line. */
  maxReason?: ReactNode;
  disabledDates?: readonly string[];
  basis?: ReactNode;
  note?: ReactNode;
  /**
   * What the entered date means, shown once one is entered. Given before a date too (worded for the date the field will
   * likely get), it holds its line unseen and unread at its wrapped height while no other detail or error uses that line,
   * so the line appearing when a date commits moves nothing.
   */
  echo?: ReactNode;
  presets?: readonly DatePreset[];
  suggestWeekday?: boolean;
  error?: ReactNode;
  remedy?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  showErrors?: boolean;
  displayFormat?: "default" | "short-weekday";
  disabled?: boolean;
}) {
  const min = minFrom && (!floor || minFrom.date > floor) ? minFrom.date : floor;
  const why = minFrom && min === minFrom.date ? minFrom.reason : undefined;
  const below = why ?? minReason;
  const filled = isDate(value);
  const disabled = new Set((disabledDates ?? []).filter(isDate));
  const out = filled && !inBounds(value, min, max);
  const unavailable = filled && (out || disabled.has(value));
  const next = filled && suggestWeekday ? nextWeekday(value) : null;
  const shown = error ?? (unavailable ? (out && below != null && min !== undefined && value < min ? below : out && maxReason != null && max !== undefined && value > max ? maxReason : out ? t("uiDate.outOfRange") : t("uiDate.disabled")) : undefined);
  const details = [
    filled ? echo : null,
    basis,
    why,
    !why && presets?.some((pr) => !inBounds(pr.date, min, max)) ? t("uiDate.outOfRange") : null,
    disabled.size > 0 ? t("uiDate.disabled") : null,
  ].filter((detail) => detail != null);
  // A date commits on blur: an echo line appearing then grew the field under a press already on its way below it.
  // With an error shown, the echo takes the error's line on commit (held beside it, the field shrank instead).
  // shortcut: a line already showing another detail (basis, a bound's reason) takes the echo unheld; hold that too if one wraps.
  const held = !filled && echo != null && details.length === 0 && shown == null;
  return (
    <div className={s.date}>
      <Field label={label} required={required} tag={note} hint={held ? echo : details.length > 0 ? details.map((detail, i) => <Fragment key={i}>{i > 0 && " · "}{detail}</Fragment>) : undefined} hintHeld={held} error={shown == null ? undefined : <>{shown}{remedy != null && <span className={s.remedy}>{remedy}</span>}</>}>
        {(p) => (
          <div className={s.row}>
            {presets && presets.length > 0 && (
              <div role="group" aria-label={t("uiDate.presets", { label })} className={s.presets}>
                {presets.map((pr) => {
                  const off = Boolean(pr.disabledReason) || !inBounds(pr.date, min, max) || disabled.has(pr.date);
                  return (
                    <button
                      key={pr.date}
                      type="button"
                      className={s.preset}
                      aria-pressed={value === pr.date}
                      aria-disabled={off || undefined}
                      aria-describedby={off ? p["aria-describedby"] : undefined}
                      title={pr.disabledReason}
                      onClick={() => !off && onChange(pr.date)}
                    >
                      {pr.label}
                      <span className={s.resolved}>{fmtDate(pr.date, { weekday: "short" })}{pr.disabledReason && <> · {pr.disabledReason}</>}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <DateInput
              id={p.id}
              value={value}
              onChange={onChange}
              onInvalid={onInvalid}
              required={p.required}
              today={today}
              min={min}
              minReason={below}
              max={max}
              maxReason={maxReason}
              disabledDates={disabledDates}
              disabled={fieldDisabled}
              displayFormat={displayFormat}
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
