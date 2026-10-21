import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import s from "./month-grid.module.css";

const GRID = { role: "grid" } as const;

/** How a day reads at a glance; never colour alone: the cell's own text names the kind (holiday name, weekly rest day). */
export type DayTone = "holiday" | "rest";

/**
 * A month as a grid of weeks (A2 calendar): one row per week, one cell per day, the neighbouring months' days muted so the
 * grid keeps its shape. WAI-ARIA grid with a roving focus: arrows move by a day or a week, Home / End to the week's
 * ends, Enter or Space (or a click) chooses the day. The caller draws each cell (`cell`) and passes the weeks
 * (Sunday-first dates) and the weekday headers, so the component knows no calendar rule of its own.
 */
export function MonthGrid({ label, weeks, weekdays, inMonth, cell, tone, selected, onSelect }: {
  label: string;
  /** Rows of 7 `YYYY-MM-DD` dates. */
  weeks: readonly (readonly string[])[];
  /** The 7 column headers, in the weeks' order. */
  weekdays: readonly string[];
  inMonth: (date: string) => boolean;
  cell: (date: string) => ReactNode;
  tone?: (date: string) => DayTone | undefined;
  selected?: string;
  onSelect?: (date: string) => void;
}) {
  const flat = weeks.flat();
  const [active, setActive] = useState<string>();
  const current = active && flat.includes(active) ? active : selected && flat.includes(selected) ? selected : flat.find(inMonth);
  const grid = useRef<HTMLTableElement>(null);
  const move = (to: number) => {
    const d = flat[Math.max(0, Math.min(flat.length - 1, to))];
    if (!d) return;
    setActive(d);
    grid.current?.querySelector<HTMLElement>(`[data-date="${d}"]`)?.focus();
  };
  const key = (e: KeyboardEvent, d: string) => {
    const i = flat.indexOf(d);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step !== undefined) move(i + step);
    else if (e.key === "Home") move(i - (i % 7));
    else if (e.key === "End") move(i - (i % 7) + 6);
    else if ((e.key === "Enter" || e.key === " ") && onSelect) onSelect(d);
    else return;
    e.preventDefault();
  };
  return (
    <table ref={grid} aria-label={label} className={s.grid} {...GRID}>
      <thead>
        <tr>
          {weekdays.map((w, i) => (
            <th key={i} scope="col" className={s.head}>{w}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0]}>
            {week.map((d) => (
              <td
                key={d}
                data-date={d}
                tabIndex={d === current ? 0 : -1}
                aria-selected={onSelect ? d === selected : undefined}
                className={s.cell}
                data-out={!inMonth(d) || undefined}
                data-tone={tone?.(d)}
                onKeyDown={(e) => key(e, d)}
                onFocus={() => setActive(d)}
                onClick={onSelect ? () => onSelect(d) : undefined}
              >
                <span className={s.day}>{Number(d.slice(8))}</span>
                {cell(d)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
