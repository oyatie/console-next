// SPDX-License-Identifier: LicenseRef-Proprietary
import { Component, lazy, Suspense, useEffect, useId, useRef, useState, type FocusEventHandler, type KeyboardEventHandler, type Ref, type ReactNode } from "react";
import { i18n, t } from "@console/i18n";
import { fmtDateInput } from "@console/i18n/format";
import { CalendarDays } from "lucide-react";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { localChunk } from "../../lib/chunk-guard";
import { todayKst } from "../../lib/pure/today";
import { TextInput } from "../field/field";
import { Skeleton } from "../skeleton/skeleton";
import { inBounds, isDate, parseTyped } from "./days";
import { typedProblem } from "./date-text";
import s from "./date.module.css";

let calendar: Promise<typeof import("./date-calendar")> | undefined;
const loadCalendar = () => calendar ??= localChunk(import("./date-calendar"));
// Speculative loads must not reload a form or reject outside its local boundary.
const prefetchCalendar = () => { void loadCalendar().catch(() => undefined); };
const DateCalendar = lazy(() => loadCalendar().then(m => ({ default: m.DateCalendar })));

class CalendarBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert">{t("uiDate.calendar.failed")}</div> : this.props.children; }
}

/** The one keyboard-and-calendar date input used by DateField and fields that already own their label. */
export function DateInput({ id, value, onChange, onDraftChange, onInvalid, required = false, today = todayKst(), min, minReason, max, maxReason, disabledDates = [], label, className, disabled, showErrors = true, "aria-describedby": describedBy, "aria-invalid": ariaInvalid, inputRef, onBlur, onKeyDown }: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  today?: string;
  /** Keep incomplete text in specialized import rows; ordinary fields only receive valid business dates. */
  onDraftChange?: (text: string) => void;
  /** Whether the last committed text was refused (unreadable, outside the bounds, blocked): an optional field's form holds its save on it. */
  onInvalid?: (invalid: boolean) => void;
  required?: boolean;
  min?: string;
  minReason?: ReactNode;
  max?: string;
  /** Why a date after `max` is refused (the caller's rule), in place of the generic out-of-range line. */
  maxReason?: ReactNode;
  disabledDates?: readonly string[];
  label?: string;
  className?: string;
  disabled?: boolean;
  showErrors?: boolean;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const errorId = useId();
  const [text, setText] = useState(() => isDate(value) ? fmtDateInput(value) : value);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const dirty = useRef(false);
  const previousValue = useRef(value);
  const emittedValue = useRef<string | undefined>(undefined);
  const blocked = new Set(disabledDates.filter(isDate));
  const minimum = min && isDate(min) ? min : undefined;
  const maximum = max && isDate(max) ? max : undefined;
  const parsed = parseTyped(text);
  const typedDate = "date" in parsed ? parsed.date : "";
  const unavailable = Boolean(typedDate && (!inBounds(typedDate, minimum, maximum) || blocked.has(typedDate)));
  const problem = showErrors && !editing
    ? ("bad" in parsed ? typedProblem(parsed) : unavailable ? (blocked.has(typedDate) ? t("uiDate.disabled") : minimum && typedDate < minimum ? minReason ?? t("uiDate.outOfRange") : maximum && typedDate > maximum ? maxReason ?? t("uiDate.outOfRange") : t("uiDate.outOfRange")) : undefined)
    : undefined;
  const described = [describedBy, problem && errorId].filter(Boolean).join(" ") || undefined;
  const initial = minimum && today < minimum ? minimum : maximum && today > maximum ? maximum : today;
  const selected = isDate(value) && inBounds(value, minimum, maximum) && !blocked.has(value) ? value : undefined;

  useEffect(() => {
    if (value === previousValue.current) return;
    previousValue.current = value;
    if (emittedValue.current === value) {
      emittedValue.current = undefined;
      return;
    }
    dirty.current = false;
    setEditing(false);
    setText(isDate(value) ? fmtDateInput(value) : value);
  }, [value]);

  const emitDraft = (draft: string) => {
    if (!onDraftChange) return;
    emittedValue.current = draft;
    onDraftChange(draft);
  };
  const emitValue = (next: string) => {
    emittedValue.current = next;
    onChange(next);
  };
  const pick = (next: string) => {
    if (!isDate(next) || !inBounds(next, minimum, maximum) || blocked.has(next)) return;
    dirty.current = false;
    setEditing(false);
    const formatted = fmtDateInput(next);
    setText(formatted);
    emitDraft(next);
    emitValue(next);
    onInvalid?.(false);
    setOpen(false);
  };
  const type = (draft: string) => {
    dirty.current = true;
    setEditing(true);
    setText(draft);
    emitDraft(draft);
  };
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    setEditing(false);
    const result = parseTyped(text);
    const ok = "date" in result && inBounds(result.date, minimum, maximum) && !blocked.has(result.date);
    if (ok) {
      setText(fmtDateInput(result.date));
      emitValue(result.date);
    } else if (!onDraftChange) emitValue("");
    onInvalid?.(!ok && text.trim() !== "");
  };

  return (
    <div className={s.inputRow}>
      <TextInput
        id={id}
        ref={inputRef}
        type="text"
        inputMode={i18n.locale === "ko" ? "numeric" : "text"}
        autoComplete="off"
        required={required}
        disabled={disabled}
        className={`${s.input}${className ? ` ${className}` : ""}`}
        aria-label={label}
        aria-describedby={described}
        aria-invalid={ariaInvalid || problem ? true : undefined}
        placeholder={t("uiDate.placeholder")}
        value={text}
        onChange={(e) => type(e.target.value)}
        onBlur={(e) => {
          commit();
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229)) commit();
          onKeyDown?.(e);
        }}
      />
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <AriaButton type="button" className={s.calendarButton} aria-label={t("uiDate.calendar.open")} aria-describedby={describedBy} isDisabled={disabled} onHoverStart={prefetchCalendar} onFocus={prefetchCalendar}>
          <CalendarDays size={18} aria-hidden />
        </AriaButton>
        <Popover className={s.popover} placement="bottom start">
          <Dialog aria-label={t("uiDate.calendar.label")} className={s.dialog}>
            {open && <CalendarBoundary><Suspense fallback={<Skeleton bones={["block"]} label={t("common.loading")} />}><DateCalendar value={selected} focused={selected ?? initial} min={minimum} max={maximum} blocked={blocked} onPick={pick} /></Suspense></CalendarBoundary>}
          </Dialog>
        </Popover>
      </DialogTrigger>
      {problem && <div id={errorId} role="alert" className={s.inputError}>{problem}</div>}
    </div>
  );
}
