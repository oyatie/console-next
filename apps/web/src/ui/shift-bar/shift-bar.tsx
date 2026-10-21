import { cut, type Span } from "./cut";
import s from "./shift-bar.module.css";

export type { Span };

/**
 * One person-day as three tracks (spec A1, §12.2 `shift-bar`): the scheduled shift as an outline, what was recorded as a
 * line under it, and inside the outline the recognised minutes solid and the recorded minutes outside them hatched (not
 * recognised). Minutes are from 00:00 of the work date; `from`–`to` is the visible window. Decorative: the row says the
 * same in words, so the bar is aria-hidden. Drawn as SVG so every span is placed by attributes, not inline style.
 */
export function ShiftBar({ from, to, scheduled, recorded, recognised, open }: {
  from: number;
  to: number;
  scheduled: readonly Span[];
  recorded: readonly Span[];
  recognised: readonly Span[];
  /** A clock-in with no clock-out: the recorded line runs dotted to the end. */
  open?: number;
}) {
  const x = (m: number) => Math.max(0, Math.min(to, m) - from);
  const w = (v: Span) => Math.max(0, x(v.end) - x(v.start));
  const outside = recorded.flatMap((r) => cut(r, recognised));
  return (
    <svg className={s.bar} viewBox={`0 0 ${to - from} 20`} preserveAspectRatio="none" aria-hidden focusable="false">
      <defs>
        <pattern id="shift-bar-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2" height="4" className={s.hatch} />
        </pattern>
      </defs>
      {scheduled.map((v, i) => <rect key={`s${i}`} className={s.plan} x={x(v.start)} y={1} width={w(v)} height={12} />)}
      {outside.map((v, i) => <rect key={`o${i}`} fill="url(#shift-bar-hatch)" x={x(v.start)} y={4} width={w(v)} height={6} />)}
      {recognised.map((v, i) => <rect key={`r${i}`} className={s.recognised} x={x(v.start)} y={4} width={w(v)} height={6} />)}
      {recorded.map((v, i) => <rect key={`l${i}`} className={s.record} x={x(v.start)} y={16} width={w(v)} height={2} />)}
      {open !== undefined && <line className={s.open} x1={x(open)} x2={to - from} y1={17} y2={17} />}
    </svg>
  );
}
