import { Check } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { label } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { CARRY, EMPLOYMENT_TYPES, type CarryKey, type Draft } from "../domain/register";
import s from "./register-run.module.css";

const TYPE = { type: "employmentType", values: EMPLOYMENT_TYPES };
const FIELD = { place: "register.run.col.place", hire: "register.run.col.hire", type: "register.run.col.type", position: "register.run.col.position", pay: "register.run.col.pay" } as const;

/**
 * The carry chips (spec E3-run): every one off at first. A chip reads as the value it would carry (the start date and its value)
 * and switches that value on for the next people of this run; a field still empty says to fill it first.
 */
export function RunCarry({ d, carry, onCarry, placeName }: { d: Draft; carry: ReadonlySet<CarryKey>; onCarry: (c: ReadonlySet<CarryKey>) => void; placeName: string }) {
  const value: Record<CarryKey, string> = {
    place: placeName,
    hire: d.hire,
    type: d.type ? label(TYPE, d.type) : "",
    position: d.position.trim(),
    pay: d.pay ? fmtNumber(Number(d.pay)) : "",
  };
  const toggle = (k: CarryKey) => {
    const next = new Set(carry);
    if (!next.delete(k)) next.add(k);
    onCarry(next);
  };
  return (
    <div className={s.carry} role="group" aria-label={t("register.run.carryTitle")}>
      <span className={s.carryLabel}>{t("register.run.carryTitle")}</span>
      {CARRY.map((k) => {
        const field = t(FIELD[k]);
        const on = carry.has(k);
        return value[k] ? (
          <Button key={k} variant="ghost" className={s.carryChip} aria-pressed={on} onClick={() => toggle(k)}>
            {on && <Check size={14} aria-hidden />}{field} {value[k]}
          </Button>
        ) : (
          <span key={k} className={s.carryChip} aria-disabled="true" title={t("register.run.carryEmpty", { field })}>{field}</span>
        );
      })}
    </div>
  );
}
