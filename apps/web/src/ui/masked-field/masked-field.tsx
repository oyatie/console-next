import { useLayoutEffect, useReducer, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Field } from "../field/field";
import { caretAfter, digits } from "./caret";
import s from "./masked-field.module.css";

/** How a masked value is kept and shown: canonical digits up to `max`, displayed with separators. */
export type MaskFormat = { max: number; display: (digits: string) => string; parse?: (raw: string) => string };

/**
 * A numeric identifier typed through a mask (design §7.4): business and corporate registration numbers, phone, insurance numbers.
 * The value is canonical digits; formatted or unformatted paste (and full-width digits) is accepted. The caret
 * stays put while separators appear, and nothing is reformatted while a Korean IME is composing (formatting
 * waits for compositionend). `warning` is a soft check (amber, never blocks); `error` is a refusal.
 */
export function MaskedField({ label, required, format, value, onChange, onBlur, hint, example, error, warning, status }: {
  label: string;
  required: boolean;
  format: MaskFormat;
  value: string;
  onChange: (digits: string) => void;
  onBlur?: () => void;
  hint?: ReactNode;
  example?: string;
  error?: ReactNode;
  warning?: ReactNode;
  /** A live result beside the value, e.g. a status lookup chip. */
  status?: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const [composing, setComposing] = useState<string | null>(null);
  // A keystroke that changes nothing (a letter) still needs a render, or React's value restore moves the caret.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const parse = format.parse ?? digits;
  const shown = composing ?? format.display(value);

  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current == null || !el || el !== document.activeElement) return;
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const commit = (raw: string, selection: number) => {
    const next = parse(raw).slice(0, format.max);
    caret.current = caretAfter(format.display(next), Math.min(digits(raw.slice(0, selection)).length, next.length));
    setComposing(null);
    rerender();
    if (next !== value) onChange(next);
  };
  const changed = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if ((e.nativeEvent as InputEvent).isComposing) setComposing(raw);
    else commit(raw, e.target.selectionStart ?? raw.length);
  };

  return (
    <Field label={label} required={required} hint={hint} example={example} error={error} warning={warning}>
      {(p) => (
        <span className={s.wrap}>
          <input
            {...p}
            ref={ref}
            className="field__input code"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={shown}
            onChange={changed}
            onCompositionEnd={(e) => commit(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
            onBlur={onBlur}
            onKeyDown={(e) => {
              // Free text is not a commit gesture; an Enter that ends IME composition is the IME's.
              if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
            }}
          />
          {status}
        </span>
      )}
    </Field>
  );
}
