import { createContext, useContext, useId, type ReactNode } from "react";
import { t } from "@console/i18n";
import { Table } from "../table";
import { cut, type Span } from "./cut";
import s from "./shift-bar.module.css";

export type { Span };
type Tracks = { scheduled: readonly Span[]; recorded: readonly Span[]; recognised: readonly Span[]; open?: number };
const Axis = createContext<{ from: number; to: number } | null>(null);

/** One scale and one legend per board; the table preserves every span, including an unfinished record. */
export function ShiftBarGroup({ rows, formatTime, children }: { rows: readonly (Tracks & { label: string })[]; formatTime: (minute: number) => string; children: ReactNode }) {
  const times = rows.flatMap(r => [...r.scheduled, ...r.recorded, ...r.recognised].flatMap(v => [v.start, v.end]).concat(r.open === undefined ? [] : [r.open]));
  const from = Math.min(0, ...times);
  const to = Math.max(24 * 60, ...times);
  const spans = (values: readonly Span[]) => values.map(v => t("uiShiftBar.span", { start: formatTime(v.start), end: formatTime(v.end) })).join(" · ") || t("uiShiftBar.none");
  return <Axis value={{ from, to }}>
    <div className={s.legend}>
      {(["scheduled", "recorded", "recognised"] as const).map(track => <span key={track}><svg viewBox="0 0 24 16" aria-hidden focusable="false"><rect className={track === "scheduled" ? s.plan : track === "recorded" ? s.record : s.recognised} x="1" y="4" width="22" height="8" /></svg>{t(`uiShiftBar.${track}`)}</span>)}
      <span>{t("uiShiftBar.axis", { start: formatTime(from), end: formatTime(to) })}</span>
    </div>
    <div className="sr-only"><Table label={t("uiShiftBar.table")} rows={rows.map((r, i) => ({ ...r, id: String(i) }))} rowId={r => r.id} columns={[
      { header: t("uiShiftBar.row"), rowHeader: true, cell: r => r.label },
      { header: t("uiShiftBar.scheduled"), cell: r => spans(r.scheduled) },
      { header: t("uiShiftBar.recorded"), cell: r => r.open === undefined ? spans(r.recorded) : t("uiShiftBar.open", { start: formatTime(r.open) }) },
      { header: t("uiShiftBar.recognised"), cell: r => spans(r.recognised) },
    ]} /></div>
    {children}
  </Axis>;
}

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
  const axis = useContext(Axis);
  if (axis) ({ from, to } = axis);
  const hatch = useId();
  const x = (m: number) => Math.max(0, Math.min(to, m) - from);
  const w = (v: Span) => Math.max(0, x(v.end) - x(v.start));
  const outside = recorded.flatMap((r) => cut(r, recognised));
  return (
    <svg className={s.bar} viewBox={`0 0 ${to - from} 20`} preserveAspectRatio="none" aria-hidden focusable="false">
      <defs>
        <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2" height="4" className={s.hatch} />
        </pattern>
      </defs>
      {scheduled.map((v, i) => <rect key={`s${i}`} className={s.plan} x={x(v.start)} y={1} width={w(v)} height={12} />)}
      {outside.map((v, i) => <rect key={`o${i}`} fill={`url(#${hatch})`} x={x(v.start)} y={4} width={w(v)} height={6} />)}
      {recognised.map((v, i) => <rect key={`r${i}`} className={s.recognised} x={x(v.start)} y={4} width={w(v)} height={6} />)}
      {recorded.map((v, i) => <rect key={`l${i}`} className={s.record} x={x(v.start)} y={16} width={w(v)} height={2} />)}
      {open !== undefined && <line className={s.open} x1={x(open)} x2={to - from} y1={17} y2={17} />}
    </svg>
  );
}
