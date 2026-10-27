import { t } from "@console/i18n";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import type { SheetVerb } from "../domain/lifecycle";
import s from "./lifecycle.module.css";

/**
 * The one live sentence above the commit, built from the values the request sends: what happens to
 * whom, from when, and whether it applies now (corrected or rescinded only from the history) or waits for its date (and can be
 * withdrawn until then). A grey line adds the interim state, the expected return, or the reservation
 * this one replaces. Standing rules are not restated: the server says them when it refuses.
 */
export function Consequence({ kind, appointJob = false, when, v, replaces, corrects }: {
  kind: SheetVerb | "relocate";
  appointJob?: boolean;
  when: "past" | "today" | "future" | "none";
  v: { name: string; date: string; from: string; to: string; fromPosition: string; toPosition: string; returnDate: string; endDate: string; fromRole: string; toRole: string; fromType: string; toType: string };
  /** The same-type reservation on this date that this one replaces (one per type, employee and date). */
  replaces?: string;
  /** The date of the applied record this one corrects : it is voided and this one takes its place. */
  corrects?: string;
}) {
  const action = kind === "relocate" ? t("lifecycle.menu.relocate") : label(LIFECYCLE_EVENT, kind);
  return (
    <>
      <span>{t(appointJob ? `lifecycle.consequence.job.${when}` : `lifecycle.consequence.${kind}.${when}`, v)}</span>
      {when === "future" && <span className={s.interim}>{t(kind === "TRANSFER" || kind === "relocate" ? "lifecycle.interim.TRANSFER" : "lifecycle.interim", v)}</span>}
      {kind === "LEAVE_OF_ABSENCE" && <span className={s.interim}>{v.returnDate ? t("lifecycle.leave.returnLine", v) : t("lifecycle.leave.noReturn")}</span>}
      {corrects && <span className={s.interim}>{t("lifecycle.correct.consequence", { date: corrects, action })}</span>}
      {replaces && <span className={s.interim}>{t("lifecycle.replaces", { date: replaces, action })}</span>}
    </>
  );
}
