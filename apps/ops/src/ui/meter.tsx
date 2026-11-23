// SPDX-License-Identifier: LicenseRef-Proprietary
import s from "./meter.module.css";

export function Meter({
  value,
  max,
  label,
  warn = false,
  danger = false,
  valueText,
}: {
  value: number;
  max: number;
  label: string;
  warn?: boolean;
  danger?: boolean;
  valueText?: string;
}) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeNow = Number.isFinite(value) ? Math.min(safeMax, Math.max(0, value)) : 0;
  const pct = Math.min(100, Math.max(safeNow > 0 ? 2 : 0, Math.round((safeNow / safeMax) * 100)));

  return (
    <span
      className={s.meter}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeNow}
      aria-valuetext={valueText}
      data-warn={warn ? "true" : undefined}
      data-danger={danger ? "true" : undefined}
    >
      <span
        className={s.fill}
        ref={(el) => {
          el?.style.setProperty("--pct", `${pct}%`);
        }}
      />
    </span>
  );
}
