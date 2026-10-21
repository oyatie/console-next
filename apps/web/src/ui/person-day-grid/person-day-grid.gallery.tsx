import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { PersonDayGrid, type Range } from "./person-day-grid";

export const order = 158;

const DAYS = Array.from({ length: 10 }, (_, i) => ({ key: String(i), label: i + 1, sub: "", tone: i === 2 || i === 4 ? ("holiday" as const) : i === 3 ? ("rest" as const) : undefined }));
const ROWS = ["10267", "10278", "10279", "10291", "10313"].map((n, i) => ({ n, v: DAYS.map((_, d) => (d === 2 || d === 3 || d === 4 ? "" : i === 0 && d === 5 ? "7:48-5:10" : "8")) }));

/** A month of cells: a range selected, one refused draft, holidays and a rest day with their tones. */
export default function PersonDayGridGallery() {
  const [range, setRange] = useState<Range>({ anchor: { row: "10278", col: "0" }, focus: { row: "10279", col: "1" } });
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.personDayGrid")}</h2>
      <PersonDayGrid
        label={tg("personDayGrid.label")}
        total={ROWS.length}
        rows={ROWS}
        rowKey={(r) => r.n}
        lead={[{ key: "n", header: tg("personDayGrid.number"), cell: (r) => r.n, width: "code" }]}
        days={DAYS}
        tail={[{ key: "t", header: tg("personDayGrid.total"), cell: () => "56:00", width: "total" }]}
        cell={(r, d) => r.v[d]}
        look={(r, d) => (r.v[d]!.includes("-") ? "refused" : undefined)}
        describe={(r, d) => `${r.n} ${d + 1}`}
        range={range}
        onRange={setRange}
        editing={null}
        onEdit={() => undefined}
        onCommit={() => undefined}
        onKey={() => false}
        rowHeight={32}
      />
    </section>
  );
}
