// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PersonDayGrid, type Range } from "./person-day-grid";
import "../../app.css";

const ROWS = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, name: `Person ${i + 1}` }));
// `?total` gives the grid ten days and one total column, as the component gallery draws it.
const total = new URLSearchParams(location.search).has("total");
// `?groups` draws each name as a link and starts a group at every third person, as the attendance month does.
const groups = new URLSearchParams(location.search).has("groups");
// `?shrink` adds a button that keeps the first 29 people and the last, as a filter or a live re-read can.
const shrink = new URLSearchParams(location.search).has("shrink");

/** 400 people. The page that loads this gives `main` its size and, for a case, its own compact row height. */
export function Fixture() {
  const [range, setRange] = useState<Range | null>({ anchor: { row: "p0", col: "1" }, focus: { row: "p0", col: "1" } });
  const [rows, setRows] = useState(ROWS);
  return (
    <main>
      {shrink && <button type="button" onClick={() => setRows(ROWS.filter((_, i) => i < 29 || i === ROWS.length - 1))}>Shrink</button>}
      <PersonDayGrid
        label="October"
        total={rows.length}
        rows={rows}
        rowKey={r => r.id}
        lead={[{ key: "n", header: "Name", cell: r => groups ? <a href={`#${r.id}`}>{r.name}</a> : r.name, width: "name" }]}
        {...(groups ? { groupOf: (r: typeof ROWS[number]) => String(Math.floor(Number(r.id.slice(1)) / 3)) } : {})}
        days={total ? Array.from({ length: 10 }, (_, i) => ({ key: String(i + 1), label: i + 1, sub: "Thu" })) : [{ key: "1", label: 1, sub: "Thu" }]}
        tail={total ? [{ key: "t", header: "Total", cell: () => "56:00", width: "total" }] : []}
        cell={() => "8"}
        look={() => undefined}
        describe={r => `${r.name} day 1`}
        range={range}
        onRange={setRange}
        editing={null}
        onEdit={() => undefined}
        onCommit={() => undefined}
        onKey={() => false}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
