import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { fmtDay } from "../present";
import s from "./lifecycle.module.css";

/** The record changed since the sheet opened (said, never acted on), or was just read again. */
export const Changed = ({ reread }: { reread: boolean }) => <p className={s.changed} role="status">{t(reread ? "lifecycle.reread.done" : "lifecycle.changed")}</p>;

/** This session's draft was put back, with the way to start over. */
export const Restored = ({ onClear }: { onClear: () => void }) => (
  <p className={s.restored} role="status">
    {t("lifecycle.draft.restored")}
    <Button variant="ghost" onClick={onClear}>{t("lifecycle.draft.clear")}</Button>
  </p>
);

/**
 * The date of a reservation being changed (kept: a new date is a new reservation, `onRebook` cancels this one) or of an
 * applied change being corrected (kept: the correction replaces it on its date).
 */
export function LockedDate({ date, correcting, onRebook }: { date: string; correcting: boolean; onRebook: () => void }) {
  return (
    <div className={s.block}>
      <p className={s.fact}>{t(correcting ? "lifecycle.date.corrected" : "lifecycle.date.locked", { date: fmtDay(date) })}</p>
      <p className={s.note}>
        {t(correcting ? "lifecycle.date.correctedHint" : "lifecycle.date.lockedHint")}{" "}
        {!correcting && <Button variant="ghost" onClick={onRebook}>{t("lifecycle.date.rebook")}</Button>}
      </p>
    </div>
  );
}
