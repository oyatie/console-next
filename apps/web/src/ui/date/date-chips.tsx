import { useRef, useState, type ReactNode } from "react";
import { t } from "@console/i18n";
import { Field } from "../field/field";
import { inBounds, parseTyped } from "./days";
import { fmtLongDay, typedProblem } from "./date-text";
import s from "./date-chips.module.css";

export type DateChip = { label: string; date: string };

/**
 * A business date picked chips-first (spec E3/E5 start date, effective date): preset chips that show the date they
 * mean, and a "type it" chip that focuses the typed field under them (2026.10.12 and 20261012 are read too). Nothing is chosen until
 * the user picks. Under it, the pick is echoed with its weekday and `echo` (what the date does); a typed text that is
 * not a date is named only once `showErrors` (a commit attempt), never while typing.
 */
export function DateChips({ label, required, note, presets, value, onChange, echo, error, showErrors, min, max, basis }: {
  label: string;
  required: boolean;
  note?: ReactNode;
  presets: readonly DateChip[];
  /** `YYYY-MM-DD`, or "" while empty or not a date yet. */
  value: string;
  onChange: (value: string) => void;
  echo?: ReactNode;
  /** The caller's own error for a date that is one (out of bounds, missing on commit). */
  error?: string;
  showErrors: boolean;
  /** The server's bounds: a chip outside them stays visible but inert, and a typed date outside is named at once. */
  min?: string;
  max?: string;
  /** Why the bounds are what they are (shown under the field). */
  basis?: ReactNode;
}) {
  const [text, setText] = useState(value);
  const [direct, setDirect] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // The value moved outside the field (a chip, a reset after save): show it. Text that is not a date yet stays as typed.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    const r = parseTyped(text);
    const shown = "date" in r ? r.date : "";
    if (shown !== value && (value !== "" || shown !== "")) setText(value);
  }
  const typed = parseTyped(text);
  const out = !!value && !inBounds(value, min, max);
  const problem = out ? t("uiDate.outOfRange") : showErrors ? (typedProblem(typed) ?? error) : undefined;
  const preset = presets.find((p) => p.date === value);
  const pick = (d: string) => (setDirect(false), setText(d), onChange(d));
  return (
    <Field
      label={label}
      required={required}
      tag={note != null ? <span className={s.note}>{note}</span> : undefined}
      error={problem}
      hint={
        <>
          {problem ? null : value ? <span className={s.echo}><span>{fmtLongDay(value)}</span>{echo != null && <span>{echo}</span>}</span> : t("uiDate.empty")}
          {basis != null && <span className={s.basis}>{basis}</span>}
        </>
      }
    >
      {(p) => (
        <div className={s.wrap} data-invalid={problem ? true : undefined}>
          <div role="group" aria-label={t("uiDate.presets", { label })} className={s.chips}>
            {presets.map((pr) => (
              <button key={pr.label} type="button" className={s.chip} aria-pressed={!direct && value === pr.date} aria-disabled={!inBounds(pr.date, min, max) || undefined} onClick={() => inBounds(pr.date, min, max) && pick(pr.date)}>
                {pr.label} <span className="num">{pr.date.slice(5)}</span>
              </button>
            ))}
            <button type="button" className={s.chip} aria-pressed={direct || (!!value && !preset)} onClick={() => (setDirect(true), requestAnimationFrame(() => input.current?.focus()))}>{t("uiDate.direct")}</button>
          </div>
          {/* Always there (empty until a pick): showing it on the first pick would push what is below it down. */}
          <input
            {...p}
            className={`field__input num ${s.input}`}
            inputMode="numeric"
            placeholder={t("uiDate.typedHint")}
            value={text}
            ref={input}
            onChange={(e) => {
              setText(e.target.value);
              const r = parseTyped(e.target.value);
              onChange("date" in r ? r.date : "");
            }}
          />
        </div>
      )}
    </Field>
  );
}
