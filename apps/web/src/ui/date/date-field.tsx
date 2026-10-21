import { useId, type ReactNode, type Ref } from "react";
import { i18n, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Field } from "../field/field";
import { daysBetween, inBounds, isDate, nextWeekday, utc } from "./days";
import s from "./date.module.css";

export type DatePreset = { label: string; date: string };

const dayFormat = (options: Intl.DateTimeFormatOptions) => (d: string) =>
  new Intl.DateTimeFormat(i18n.locale === "ko" ? "ko-KR" : "en-US", { timeZone: "UTC", ...options }).format(utc(d));
/** Month, day and weekday, e.g. "Sun, Nov 1" in English. */
const fmtDay = dayFormat({ month: "long", day: "numeric", weekday: "short" });
const fmtWeekday = dayFormat({ weekday: "long" });

/**
 * A business date (components.html §5). Empty until the user picks: there is no default, because the
 * date changes the outcome. `min`/`max` are the server's bounds and `basis` says why (a closed period,
 * the hire date); a date outside them shows `outOfRange` under the field with `remedy` (e.g. a backdating
 * request). Presets show the date they resolve to; put the immediate value last, never first. The
 * echo repeats the pick as weekday and D-n against `today` (the business date, from lib/pure/today).
 * `suggestWeekday` adds a weekend notice with a one-click change; it never changes the value itself.
 * `minFrom` is the server's earliest date for this act and why (a loosening applies 24 h after approval):
 * it tightens `min`, its reason joins the bounds line and is the error for an earlier pick, and presets
 * outside the bounds stay visible but inert, described by that line.
 */
export function DateField({ label, required, value, onChange, today, min: floor, minFrom, max, basis, presets, suggestWeekday = false, error, remedy, inputRef }: {
  label: string;
  required: boolean;
  /** `YYYY-MM-DD`, or "" while empty. */
  value: string;
  onChange: (value: string) => void;
  today: string;
  min?: string;
  minFrom?: { date: string; reason: ReactNode };
  max?: string;
  basis?: ReactNode;
  presets?: readonly DatePreset[];
  suggestWeekday?: boolean;
  error?: ReactNode;
  remedy?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const boundsId = useId();
  const min = minFrom && (!floor || minFrom.date > floor) ? minFrom.date : floor;
  const why = minFrom && min === minFrom.date ? minFrom.reason : undefined;
  const filled = isDate(value);
  const out = filled && !inBounds(value, min, max);
  const next = filled && suggestWeekday ? nextWeekday(value) : null;
  const shown = error ?? (out ? (why != null && min !== undefined && value < min ? why : t("uiDate.outOfRange")) : undefined);
  const days = filled ? daysBetween(today, value) : 0;
  const relative = days === 0 ? t("uiDate.today") : days > 0 ? t("uiDate.ahead", { days }) : t("uiDate.ago", { days: -days });
  const range =
    min && max ? t("uiDate.bounds", { min: fmtDate(min), max: fmtDate(max) })
    : min ? t("uiDate.bounds.from", { min: fmtDate(min) })
    : max ? t("uiDate.bounds.until", { max: fmtDate(max) })
    : null;
  const notes = [basis, why].filter((n) => n != null);
  const hint = filled || range || notes.length > 0 ? (
    <span className={s.lines}>
      {filled && <span className={s.echo}>{fmtDay(value)}<span className={s.rel}>{relative}</span></span>}
      {(range || notes.length > 0) && (
        <span id={boundsId} className={s.bounds}>
          {range}
          {notes.map((n, i) => (range || i > 0 ? <span key={i} className={s.sep}>{n}</span> : <span key={i}>{n}</span>))}
        </span>
      )}
    </span>
  ) : undefined;
  return (
    <div className={s.date}>
      <Field label={label} required={required} hint={hint} error={shown == null ? undefined : <>{shown}{remedy != null && <span className={s.remedy}>{remedy}</span>}</>}>
        {(p) => (
          <div className={s.row}>
            {presets && presets.length > 0 && (
              <div role="group" aria-label={t("uiDate.presets", { label })} className={s.presets}>
                {presets.map((pr) => {
                  const off = !inBounds(pr.date, min, max);
                  return (
                    <button
                      key={pr.date}
                      type="button"
                      className={s.preset}
                      aria-pressed={value === pr.date}
                      aria-disabled={off || undefined}
                      aria-describedby={off ? boundsId : undefined}
                      onClick={() => !off && onChange(pr.date)}
                    >
                      {pr.label}
                      <span className={s.resolved}>{fmtDay(pr.date)}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <input {...p} ref={inputRef} type="date" className={`field__input ${s.input}`} value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)} />
          </div>
        )}
      </Field>
      {next && (
        <p className={s.suggest}>
          {t("uiDate.weekend", { day: fmtWeekday(value), next: fmtDay(next) })}
          <button type="button" className="link" onClick={() => onChange(next)}>{t("uiDate.weekend.use", { next: fmtDay(next) })}</button>
        </p>
      )}
    </div>
  );
}
