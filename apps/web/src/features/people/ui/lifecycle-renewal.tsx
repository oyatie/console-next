import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fixedTermQuery } from "../api";
import { Button } from "../../../ui/button/button";
import { DateChips } from "../../../ui/date/date-chips";
import { endPresets, periodPresets } from "../domain/presets";
import { fmtDayShort } from "../present";
import s from "./lifecycle.module.css";

/**
 * A renewal's new contract end. Whole periods from the day after the current contract set both dates
 * in one press (shown resolved); single-date suggestions stay for a custom period. Nothing is chosen
 * until pressed.
 */
export function RenewalFields({ employeeId, contractEnd, start, bounds, end, onEnd, onPeriod, error, locked }: {
  employeeId: string;
  contractEnd: string | null | undefined;
  start: string;
  bounds: { min?: string; max?: string };
  end: string;
  onEnd: (date: string) => void;
  onPeriod: (start: string, end: string) => void;
  error?: string;
  /** A correction keeps the contract end (changing it needs a second person). */
  locked?: boolean;
}) {
  const periods = periodPresets(contractEnd, bounds);
  const presets = endPresets(start).map((p) => ({ label: p.months % 12 ? t("lifecycle.preset.plusMonths", { months: p.months }) : t("lifecycle.preset.plusYears", { years: p.months / 12 }), date: p.date }));
  return (
    <>
      {contractEnd && <p className={s.fact}>{t("lifecycle.renewal.current", { date: fmtDayShort(contractEnd) })}</p>}
      <FixedTerm employeeId={employeeId} end={end} />
      {locked ? (
        <p className={s.fact}>{t("lifecycle.renewal.endLocked", { date: end ? fmtDayShort(end) : "—" })}</p>
      ) : (
        <>
      {periods.length > 0 && (
        <div className={s.periods} role="group" aria-label={t("lifecycle.renewal.periods")}>
          {periods.map((p) => (
            <Button key={p.months} aria-pressed={start === p.start && end === p.end} onClick={() => onPeriod(p.start, p.end)}>
              {t("lifecycle.renewal.period", { years: p.months / 12, start: fmtDayShort(p.start), end: fmtDayShort(p.end) })}
            </Button>
          ))}
        </div>
      )}
      <DateChips label={t("lifecycle.renewal.end")} required presets={presets} value={end} onChange={onEnd} min={start || undefined} error={error} showErrors={error != null} />
        </>
      )}
    </>
  );
}

/**
 * BW-12 (Fixed-term Act Art. 4(1)): the cumulative fixed-term service and the last day inside the two-year limit, from the
 * server; a new end past it is said before commit (the server refuses it unless an exception admits it).
 */
function FixedTerm({ employeeId, end }: { employeeId: string; end: string }) {
  const q = useQuery(fixedTermQuery(employeeId));
  const f = q.data;
  if (!f?.applies || f.cumulative_days == null) return null;
  const over = Boolean(f.two_year_date && end && end > f.two_year_date);
  return (
    <div className={s.block} role="group" aria-label={t("lifecycle.fixedTerm.title")}>
      <p className={s.fact}>
        {t("lifecycle.fixedTerm.service", { days: f.cumulative_days })}
        {f.two_year_date && <> · {t("lifecycle.fixedTerm.limit", { date: fmtDayShort(f.two_year_date) })}</>}
      </p>
      {f.basis === "HIRE_DATE_FALLBACK" && <p className={s.note}>{t("lifecycle.fixedTerm.fallback")}</p>}
      {over && <p className={s.warn} role="status">{t("lifecycle.fixedTerm.over", { date: fmtDayShort(f.two_year_date!) })}</p>}
    </div>
  );
}
