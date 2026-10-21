// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useId, useRef, useState, type FocusEventHandler, type KeyboardEventHandler, type Ref, type ReactNode } from "react";
import { parseDate } from "@internationalized/date";
import { i18n, t } from "@console/i18n";
import { fmtDateInput } from "@console/i18n/format";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button as AriaButton, Calendar, CalendarCell, CalendarGrid, CalendarHeading, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { todayKst } from "../../lib/pure/today";
import { TextInput } from "../field/field";
import { inBounds, isDate, parseTyped } from "./days";
import { typedProblem } from "./date-text";
import s from "./date.module.css";

/** The one keyboard-and-calendar date input used by DateField and fields that already own their label. */
export function DateInput({ id, value, onChange, onDraftChange, required = false, today = todayKst(), min, minReason, max, disabledDates = [], label, className, disabled, showErrors = true, "aria-describedby": describedBy, "aria-invalid": ariaInvalid, inputRef, onBlur, onKeyDown }: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  today?: string;
  /** Keep incomplete text in specialized import rows; ordinary fields only receive valid business dates. */
  onDraftChange?: (text: string) => void;
  required?: boolean;
  min?: string;
  minReason?: ReactNode;
  max?: string;
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
    ? ("bad" in parsed ? typedProblem(parsed) : unavailable ? (blocked.has(typedDate) ? t("uiDate.disabled") : minimum && typedDate < minimum ? minReason ?? t("uiDate.outOfRange") : t("uiDate.outOfRange")) : undefined)
    : undefined;
  const described = [describedBy, problem && errorId].filter(Boolean).join(" ") || undefined;
  const selected = isDate(value) ? parseDate(value) : null;
  const initial = minimum && today < minimum ? minimum : maximum && today > maximum ? maximum : today;
  const focused = selected && inBounds(value, minimum, maximum) && !blocked.has(value) ? selected : parseDate(initial);

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
    if ("date" in result && inBounds(result.date, minimum, maximum) && !blocked.has(result.date)) {
      setText(fmtDateInput(result.date));
      emitValue(result.date);
    } else if (!onDraftChange) emitValue("");
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
        <AriaButton type="button" className={s.calendarButton} aria-label={t("uiDate.calendar.open")} aria-describedby={describedBy} isDisabled={disabled}>
          <CalendarDays size={18} aria-hidden />
        </AriaButton>
        <Popover className={s.popover} placement="bottom start">
          <Dialog aria-label={t("uiDate.calendar.label")} className={s.dialog}>
            <Calendar
              aria-label={t("uiDate.calendar.label")}
              value={selected && inBounds(value, minimum, maximum) && !blocked.has(value) ? selected : null}
              defaultFocusedValue={focused}
              minValue={minimum ? parseDate(minimum) : undefined}
              maxValue={maximum ? parseDate(maximum) : undefined}
              isDateUnavailable={(date) => blocked.has(date.toString())}
              onChange={(date) => date && pick(date.toString())}
              className={s.calendar}
            >
              <header className={s.calendarHeader}>
                <AriaButton slot="previous" type="button" className={s.monthButton} aria-label={t("uiDate.calendar.previous")}><ChevronLeft size={18} aria-hidden /></AriaButton>
                <CalendarHeading className={s.monthHeading} />
                <AriaButton slot="next" type="button" className={s.monthButton} aria-label={t("uiDate.calendar.next")}><ChevronRight size={18} aria-hidden /></AriaButton>
              </header>
              <CalendarGrid className={s.grid} weekdayStyle="short">
                {(date) => <CalendarCell date={date} className={s.calendarDay} />}
              </CalendarGrid>
            </Calendar>
          </Dialog>
        </Popover>
      </DialogTrigger>
      {problem && <div id={errorId} role="alert" className={s.inputError}>{problem}</div>}
    </div>
  );
}
