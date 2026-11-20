import s from "./meter.module.css";

export type MeterProps = {
  /** Current measured value in `[0, max]`. */
  value: number;
  /** Maximum range value (`> 0`). */
  max: number;
  /** Accessible name for `aria-label` (never visible). */
  label: string;
  /** Highlight the fill with warning colour. */
  warn?: boolean;
  /** Optional cell count for segmented display (for example `30` half-day cells for 15-day leave). */
  cells?: number;
  /** Optional proposed increment after `value` shown in segmented mode. */
  pending?: number;
  /** Optional human-readable reading for `aria-valuetext`. */
  valueText?: string;
};

type CellState = "used" | "partial-used" | "pending" | "partial-pending" | "rest";

const EPS = 1e-6;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** A small continuous bar or segmented cell strip with its reading exposed via ARIA meter attributes. */
export function Meter({ value, max, label, warn, cells, pending, valueText }: MeterProps) {
  const count = cells != null && Number.isFinite(cells) ? Math.floor(cells) : 0;
  const segmented = count > 0;
  const usedEnd = segmented && max > 0 ? clamp01(value / max) * count : 0;
  const pendingEnd = segmented && max > 0 ? clamp01((Math.max(0, value) + Math.max(0, pending ?? 0)) / max) * count : 0;
  const pct = !segmented && max > 0 ? Math.min(100, Math.max(2, Math.round((value / max) * 100))) : 0;

  return (
    <span
      className={s.meter}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      data-segmented={segmented ? "true" : undefined}
      data-warn={warn || undefined}
    >
      {segmented ? (
        Array.from({ length: count }, (_, i) => {
          let state: CellState = "rest";
          let cellPct: number | undefined;
          if (usedEnd >= i + 1 - EPS) {
            state = "used";
          } else if (usedEnd > i + EPS) {
            state = "partial-used";
            cellPct = Math.min(99, Math.max(1, Math.round((usedEnd - i) * 100)));
          } else if (pendingEnd >= i + 1 - EPS) {
            state = "pending";
          } else if (pendingEnd > i + EPS) {
            state = "partial-pending";
            cellPct = Math.min(99, Math.max(1, Math.round((pendingEnd - i) * 100)));
          }

          return (
            <span
              key={i}
              className={s.cell}
              data-state={state}
              data-pct={cellPct}
              aria-hidden="true"
              ref={(el) => {
                if (!el) return;
                if (cellPct !== undefined) el.style.setProperty("--pct", `${cellPct}%`);
                else el.style.removeProperty("--pct");
              }}
            />
          );
        })
      ) : (
        <span className={s.fill} data-pct={pct} ref={(el) => el?.style.setProperty("--pct", `${pct}%`)} />
      )}
    </span>
  );
}
