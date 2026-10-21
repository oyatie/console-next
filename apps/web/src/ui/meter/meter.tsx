import s from "./meter.module.css";

/** A small progress bar (retention left, a job's n/N), with its value in words for assistive tech. */
export function Meter({ value, max, label, warn }: { value: number; max: number; label: string; warn?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.max(2, Math.round((value / max) * 100))) : 0;
  return (
    <span className={s.meter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} data-warn={warn || undefined}>
      <span className={s.fill} data-pct={pct} ref={(el) => el?.style.setProperty("--pct", `${pct}%`)} />
    </span>
  );
}
