import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { t } from "@console/i18n";
import { Button, IconButton } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { blankSlot, moveItem, type SlotForm } from "../domain/day-form";
import { DayEditor } from "./day-editor";
import { useKeys } from "./use-keys";
import s from "./attendance.module.css";

type Row = { slot: SlotForm; i: number; count: number; error?: string; onChange: (x: SlotForm) => void; onMove: (by: number) => void; onRemove?: () => void };

/** One rotation slot; Alt+Up / Alt+Down move it while focus is inside. */
function SlotRow({ slot, i, count, error, onChange, onMove, onRemove }: Row) {
  const keys = useKeys<HTMLDivElement>((e) => (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") ? (onMove(e.key === "ArrowUp" ? -1 : 1), true) : false));
  return (
    <div ref={keys} className="form__group" role="group" aria-label={t("attendancePatterns.slots.nth", { n: i + 1 })}>
      <div className={s.listHead}>
        <Field label={t("attendancePatterns.slots.code", { n: i + 1 })} required example={t("attendancePatterns.slots.codeExample")}>
          {(p) => <TextInput {...p} value={slot.code} maxLength={4} onChange={(e) => onChange({ ...slot, code: e.target.value })} />}
        </Field>
        <span className={s.slotTools}>
          <IconButton label={t("attendancePatterns.slots.up", { n: i + 1 })} size="sm" disabled={i === 0} onClick={() => onMove(-1)}><ChevronUp size={16} aria-hidden /></IconButton>
          <IconButton label={t("attendancePatterns.slots.down", { n: i + 1 })} size="sm" disabled={i === count - 1} onClick={() => onMove(1)}><ChevronDown size={16} aria-hidden /></IconButton>
          {onRemove && <Button size="sm" variant="ghost-danger" onClick={onRemove}><Trash2 size={16} aria-hidden /> {t("attendancePatterns.slots.remove")}</Button>}
        </span>
      </div>
      <DayEditor label={t("attendancePatterns.slots.day", { n: i + 1 })} value={slot} onChange={(d) => onChange({ ...d, code: slot.code })} error={error} />
    </div>
  );
}

/**
 * Rotation slots (A2-types): one slot is one day, in order; the cycle is the slot count, shown and never typed.
 * Each slot moves with its up and down buttons, or Alt+Up / Alt+Down while focus is in it.
 */
export function SlotEditor({ slots, onChange, errors }: { slots: readonly SlotForm[]; onChange: (s: SlotForm[]) => void; errors: (i: number) => string | undefined }) {
  return (
    <div className="form">
      <p className="muted">{t("attendancePatterns.slots.cycle", { days: slots.length })}</p>
      {slots.map((slot, i) => (
        <SlotRow
          key={i}
          slot={slot}
          i={i}
          count={slots.length}
          error={errors(i)}
          onChange={(x) => onChange(slots.map((y, j) => (j === i ? x : y)))}
          onMove={(by) => onChange(moveItem(slots, i, by))}
          onRemove={slots.length > 2 ? () => onChange(slots.filter((_, j) => j !== i)) : undefined}
        />
      ))}
      <Button size="sm" disabled={slots.length >= 56} onClick={() => onChange([...slots, blankSlot()])}><Plus size={16} aria-hidden /> {t("attendancePatterns.slots.add")}</Button>
    </div>
  );
}
