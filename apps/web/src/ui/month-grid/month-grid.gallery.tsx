import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { MonthGrid } from "./month-grid";

export const order = 157;

const WEEKS = [0, 1, 2, 3, 4].map((w) => Array.from({ length: 7 }, (_, d) => new Date(Date.UTC(2026, 8, 27 + w * 7 + d)).toISOString().slice(0, 10)));

/** October 2026: weekly rest day on Sundays, National Foundation Day and its substitute holiday, Hangul Day; a day chosen. */
export default function MonthGridGallery() {
  const [day, setDay] = useState("2026-10-05");
  const holiday: Record<string, string> = { "2026-10-03": tg("monthGrid.foundation"), "2026-10-05": tg("monthGrid.substitute"), "2026-10-09": tg("monthGrid.hangul") };
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.monthGrid")}</h2>
      <MonthGrid
        label={tg("monthGrid.label")}
        weeks={WEEKS}
        weekdays={tg("monthGrid.weekdays").split(",")}
        inMonth={(d) => d.startsWith("2026-10")}
        tone={(d) => (holiday[d] ? "holiday" : new Date(`${d}T00:00:00Z`).getUTCDay() === 0 ? "rest" : undefined)}
        cell={(d) => holiday[d] ?? (new Date(`${d}T00:00:00Z`).getUTCDay() === 0 ? tg("monthGrid.weekly") : null)}
        selected={day}
        onSelect={setDay}
      />
    </section>
  );
}
