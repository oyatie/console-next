// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fixedTermQuery } from "../api";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { endPresets, periodPresets } from "../domain/presets";
import { fmtDayShort } from "../present";
import { QueryState } from "../../../lib/react/query-state";
import { FixedTermRule } from "./legal-preflight";
import s from "./lifecycle.module.css";

/**
 * A renewal's new contract end. Whole periods from the day after the current contract set both dates
 * in one press (shown resolved); single-date suggestions stay for a custom period. Nothing is chosen
 * until pressed.
 */
export function RenewalFields({ employeeId, contractEnd, start, today, bounds, end, onEnd, onPeriod, error, locked, onConvert, onNoRenewal, exceptionId, onException }: {
  onConvert?: () => void;
  onNoRenewal?: () => void;
  exceptionId?: string;
  onException?: (id: string) => void;
  employeeId: string;
  contractEnd: string | null | undefined;
  start: string;
  today: string;
  bounds: { min?: string; max?: string };
  end: string;
  onEnd: (date: string) => void;
  onPeriod: (start: string, end: string) => void;
  error?: string;
  /** A correction keeps the contract end (changing it needs a second person). */
  locked?: boolean;
}) {
  const query = useQuery(fixedTermQuery(employeeId));
  const f = query.data;
  const limit = f?.two_year_date ?? undefined;
  const disabledReason = limit ? t("lifecycle.fixedTerm.over", { date: fmtDayShort(limit), years: f?.rule?.value ?? "—" }) : undefined;
  const over = Boolean(limit && end && end > limit);
  const [exception, setException] = useState(Boolean(exceptionId));
  const options = useQuery({ ...fixedTermQuery(employeeId, end), enabled: over && !locked });
  const choices = options.data?.available_exceptions ?? [];
  const periods = periodPresets(contractEnd, bounds, limit);
  const presets = endPresets(start, limit).map((p) => ({ label: p.months % 12 ? t("lifecycle.preset.plusMonths", { months: p.months }) : t("lifecycle.preset.plusYears", { years: p.months / 12 }), date: p.date, disabledReason: p.disabledReason ? disabledReason : undefined }));
  return (
    <>
      {contractEnd && <p className={s.fact}>{t("lifecycle.renewal.current", { date: fmtDayShort(contractEnd) })}</p>}
      <QueryState q={query}>{(facts) => <FixedTermRule f={facts} end={end} />}</QueryState>
      {(query.isPending || query.isError) && <FixedTermRule unavailable />}
      {locked ? (
        <p className={s.fact}>{t("lifecycle.renewal.endLocked", { date: end ? fmtDayShort(end) : "—" })}</p>
      ) : (
        <>
      {periods.length > 0 && (
        <div className={s.periods} role="group" aria-label={t("lifecycle.renewal.periods")}>
          {periods.map((p) => (
            <Button key={p.months} aria-pressed={start === p.start && end === p.end} aria-disabled={Boolean(p.disabledReason) || undefined} title={p.disabledReason ? disabledReason : undefined} onClick={() => !p.disabledReason && onPeriod(p.start, p.end)}>
              {t("lifecycle.renewal.period", { years: p.months / 12, start: fmtDayShort(p.start), end: fmtDayShort(p.end) })}
              {p.disabledReason && <span className={s.note}>{disabledReason}</span>}
            </Button>
          ))}
        </div>
      )}
      <DateField label={t("lifecycle.renewal.end")} required today={today} presets={presets} value={end} onChange={onEnd} min={start || undefined} error={error} showErrors={error != null} />
        </>
      )}
      {!locked && over && <div className={s.block}>
        <div className={s.periods}>
          {onConvert && <Button onClick={onConvert}>{t("lifecycle.fixedTerm.convert")}</Button>}
          {onNoRenewal && <Button onClick={onNoRenewal}>{t("lifecycle.fixedTerm.noRenewal")}</Button>}
          {choices.length > 0 && <Button aria-expanded={exception} onClick={() => { setException(!exception); onException?.(""); }}>{t("lifecycle.fixedTerm.exception")}</Button>}
        </div>
        {exception && choices.length > 0 && <QueryState q={options}>{(data) => {
          const choices = data.available_exceptions ?? [];
          const selected = choices.find((x) => x.id === exceptionId);
          return choices.length ? <>
            <Field label={t("lifecycle.fixedTerm.exceptionId")} required>
              {(props) => <SelectInput {...props} value={selected?.id ?? ""} onChange={(e) => onException?.(e.target.value)}>
                <option value="" disabled>{t("uiChoice.placeholder", { label: t("lifecycle.fixedTerm.exceptionId") })}</option>
                {choices.map((x) => <option key={x.id} value={x.id}>{t(`lifecycle.fixedTerm.ground.${x.ground_code}`)} · {x.basis}{x.note && ` · ${x.note}`}</option>)}
              </SelectInput>}
            </Field>
          </> : <p role="status">{t("lifecycle.fixedTerm.noExceptions")}</p>;
        }}</QueryState>}
      </div>}
    </>
  );
}
