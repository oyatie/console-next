import type { ReactNode } from "react";
import { ArrowDownUp, Lock } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Segmented } from "../../../ui/button/segmented";
import { Band } from "../../../ui/band/band";
import { SelectField } from "../../../ui/select/select-field";
import { REVIEWS, SORTS, headcount, toggleReview, type Review, type RosterSort, type StatusView } from "../domain/roster";
import type { Density } from "./use-roster-columns";
import { RosterScope } from "./roster-scope";
import { SOON_DAYS } from "./use-roster";
import s from "./roster.module.css";

type Totals<K extends string> = { totals: Record<K, number | undefined>; failed: boolean[] };

/** A chip's count, or a dash with the reason when its read failed. */
const n = (v: number | undefined, failed: boolean) => (failed ? <span title={t("roster.count.failed")}>{"—"}</span> : v === undefined ? "" : fmtNumber(v));

/**
 * The roster's scope and its chips (E1): the scope (a unit, as a search picker), then the status chips with their
 * arithmetic on screen (active + on leave = headcount; starting soon counted apart; exit kept 3 years), then the to-do chips. A status chip
 * is one choice (pressed = shown); to-do chips toggle and combine with AND. Every count is the server's total.
 */
export function RosterFilters({ status, review, unit, sort, counts, onChange, findSlot, density, onDensity, tools }: {
  status: StatusView;
  review: readonly Review[];
  unit?: string;
  sort: RosterSort;
  counts: { status: Totals<StatusView>; review: Totals<Review> };
  onChange: (f: { status?: StatusView; review?: Review[]; unit?: string | null; sort?: RosterSort }) => void;
  /** Where the table's search lands, in this band. */
  findSlot: (el: HTMLElement | null) => void;
  density: Density;
  onDensity: (d: Density) => void;
  /** The scope row's end: the column chooser. */
  tools?: ReactNode;
}) {
  const st = counts.status;
  const failed = st.failed.some(Boolean);
  const chip = (v: StatusView, label: string, icon?: boolean) => (
    <ToggleButton key={v} look="chip" count={n(st.totals[v], failed)} pressed={status === v || (status === "current" && v !== "EXITED" && v !== "UNKNOWN")} onClick={() => onChange({ status: status === v ? "current" : v })}>
      {icon && <Lock size={12} aria-hidden />}{label}{" "}
    </ToggleButton>
  );
  const pending = (st.totals.ACTIVE === undefined && !failed) || (counts.review.totals.contractSoon === undefined && !counts.review.failed.some(Boolean));
  return (
    <>
      <Band className={s.scope}>
        <RosterScope value={unit} onChange={(v) => onChange({ unit: v })} />
        {unit && <Button variant="ghost" onClick={() => onChange({ unit: null })}>{t("people.filter.anyUnit")}</Button>}
        <span ref={findSlot} className={s.findSlot} />
        <span className={s.sortPick}>
          <SelectField label={t("roster.sort.label")} hideLabel options={SORTS.map((x) => ({ id: x, label: t(`roster.sort.${x}`) }))} value={sort} onChange={(v) => onChange({ sort: v as RosterSort })} placeholder={t("roster.sort.label")} icon={<ArrowDownUp size={14} aria-hidden />} />
        </span>
        <Segmented label={t("roster.columns.density")} value={density} onChange={onDensity} items={(["compact", "regular"] as const).map((d) => ({ id: d, label: t(`roster.density.${d}`) }))} />
        {tools}
      </Band>
      {/* One row that never wraps, its chips shown once both counts land: a count arriving cannot move a control. */}
      <Band tone="canvas" className={s.stats} role="group" aria-label={t("people.filter.label")} data-pending={pending || undefined}>
        <span className={s.lab} id="roster-status">{t("roster.group.status")}</span>
        <span role="group" aria-labelledby="roster-status" className={s.chips}>
          {chip("ACTIVE", t("roster.status.ACTIVE"))}
          <span className={s.op}>{t("roster.plus")}</span>
          {chip("ON_LEAVE", t("roster.status.ON_LEAVE"))}
          <span className={s.sum}>{t("roster.sum", { count: headcount(st.totals) ?? 0 })}</span>
          {chip("PRE_HIRE", t("roster.status.PRE_HIRE"))}
          {((st.totals.UNKNOWN ?? 0) > 0 || status === "UNKNOWN") && chip("UNKNOWN", t("roster.status.UNKNOWN"))}
          {chip("EXITED", t("roster.status.EXITED.kept"), true)}
        </span>
        <span className={s.lab} id="roster-review">{t("roster.group.review")}</span>
        <span role="group" aria-labelledby="roster-review" className={s.chips}>
          {REVIEWS.map((r, i) => (
            <ToggleButton
              key={r}
              look="chip"
              countTone={r !== "contractSoon" ? "warn" : undefined}
              count={n(counts.review.totals[r], counts.review.failed[i]!)}
              pressed={review.includes(r)}
              title={t(`roster.review.${r}.title`, { days: SOON_DAYS })}
              onClick={() => onChange({ review: toggleReview(review, r) })}
            >
              {t(`roster.review.${r}`, { days: SOON_DAYS })}{" "}
            </ToggleButton>
          ))}
        </span>
      </Band>
    </>
  );
}
