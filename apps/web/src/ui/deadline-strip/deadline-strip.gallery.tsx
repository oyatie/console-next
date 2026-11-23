// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { DeadlineStrip } from "./deadline-strip";

export const order = 91;

const DAYS = [
  { date: "2026-11-08", dayLabel: "08", bucket: "over" },
  { date: "2026-11-10", dayLabel: "10", bucket: "today" },
  { date: "2026-11-12", dayLabel: "12", bucket: "upcoming" },
  { date: "2026-11-14", dayLabel: "14", bucket: "upcoming" },
] as const;

/** Horizontal day-by-lane deadline schedule strip with statutory and operational badges. */
export default function DeadlineStripGallery() {
  const [selected, setSelected] = useState("e-3");

  return (
    <section className="card gallery__section" data-deadline-strip-gallery="">
      <h2 className="toolbar__title">{t("uiWorklist.schedule")}</h2>
      <DeadlineStrip
        monthLabel="11"
        days={DAYS}
        selectedId={selected}
        onSelect={setSelected}
        entries={[
          { id: "e-1", shortLabel: "D1", fullLabel: tg("sample.person", { n: 1 }), lane: "operational", date: "2026-11-08", tone: "over" },
          { id: "e-2", shortLabel: "D2", fullLabel: tg("sample.person", { n: 2 }), lane: "operational", date: "2026-11-10", tone: "today" },
          { id: "e-3", shortLabel: "D3", fullLabel: tg("sample.person", { n: 3 }), lane: "operational", date: "2026-11-12", tone: "upcoming" },
          { id: "e-4", shortLabel: "S1", fullLabel: tg("sample.person", { n: 4 }), lane: "statutory", date: "2026-11-14" },
          { id: "e-5", shortLabel: "U1", fullLabel: tg("sample.person", { n: 5 }), lane: "operational", date: null, tone: "undated" },
        ]}
      />
    </section>
  );
}
