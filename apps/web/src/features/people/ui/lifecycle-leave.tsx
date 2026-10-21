import { t } from "@console/i18n";
import { LEAVE_TYPE, label } from "../../../lib/labels";
import { ChoiceField } from "../../../ui/choice/choice-field";
import type { ReactNode } from "react";
import { DateChips } from "../../../ui/date/date-chips";
import { addDays } from "../../../ui/date/days";
import { returnPresets } from "../domain/presets";
import { returnRequired } from "../domain/leave";
import { fmtDayShort } from "../present";
import s from "./lifecycle.module.css";

/**
 * A leave's type (required, nothing chosen until the user picks) and expected return: required for childcare leave
 * (Equal Employment Act Art. 19) and maternity leave (Labor Standards Act Art. 74), optional otherwise (BW-13; the server refuses the same).
 */
export function LeaveFields({ start, type, onType, returnDate, onReturn, typeError, returnError, locked, startSlot, tried }: {
  start: string;
  type: string | null;
  onType: (type: string | null) => void;
  returnDate: string;
  onReturn: (date: string) => void;
  typeError?: string;
  returnError?: string;
  /** A correction keeps the return date (changing it needs a second person). */
  locked?: boolean;
  /** The start date control, drawn beside the expected return (spec E5-leave). */
  startSlot?: ReactNode;
  tried: boolean;
}) {
  const presets = returnPresets(start).map((p) => ({ label: p.months % 12 ? t("lifecycle.preset.plusMonths", { months: p.months }) : t("lifecycle.preset.plusYears", { years: p.months / 12 }), date: p.date }));
  return (
    <>
      <ChoiceField
        label={t("lifecycle.leave.type")}
        required
        look="chips"
        options={LEAVE_TYPE.values.map((v) => ({ value: v, label: label(LEAVE_TYPE, v), disabled: locked && !returnDate && returnRequired(v) ? t("lifecycle.leave.dateLocked") : undefined }))}
        value={type}
        onChange={onType}
        error={typeError}
      />
      <div className={s.pair}>
        {startSlot}
        {locked ? (
          <p className={s.fact}>{returnDate ? t("lifecycle.leave.returnLocked", { date: fmtDayShort(returnDate) }) : t("lifecycle.leave.noReturn")}</p>
        ) : (
          <DateChips
            label={t("lifecycle.leave.return")}
            required={returnRequired(type)}
            error={returnError}
            showErrors={tried}
            value={returnDate}
            onChange={onReturn}
            min={start ? addDays(start, 1) : undefined}
            presets={presets}

          />
        )}
      </div>
    </>
  );
}
