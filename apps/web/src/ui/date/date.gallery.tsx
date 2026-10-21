import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { DateField } from "./date-field";

export const order = 120;

// A fixed business date keeps the gallery's echo and screenshots stable.
const TODAY = "2026-10-01";
const BOUNDS = { min: "2026-10-01", max: "2027-09-30" };
const PRESETS = [
  { label: tg("date.nextMonth"), date: "2026-11-01" },
  { label: tg("date.monthEnd"), date: "2026-10-31" },
];

// The server's earliest date for a loosening: presets before it stay visible but inert.
const LATER = { date: "2026-11-01", reason: tg("date.minFromWhy") };

function Demo({ initial, presets = false, minFrom }: { initial: string; presets?: boolean; minFrom?: typeof LATER }) {
  const [value, setValue] = useState(initial);
  return (
    <DateField
      label={tg("date.effective")}
      required
      value={value}
      onChange={setValue}
      today={TODAY}
      {...BOUNDS}
      minFrom={minFrom}
      basis={tg("date.basis")}
      presets={presets ? PRESETS : undefined}
      suggestWeekday
      remedy={<button type="button" className="btn">{tg("date.backdate")}</button>}
    />
  );
}

export default function DateGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.date")}</h2>
      <div className="grid-3">
        <Demo initial="" presets />
        <Demo initial="2026-11-01" />
        <Demo initial="2026-09-28" />
        <Demo initial="" presets minFrom={LATER} />
      </div>
    </section>
  );
}
