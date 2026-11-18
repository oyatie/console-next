// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useState, type CSSProperties } from "react";
import { PersonDayGrid, type Range } from "./person-day-grid";
import "../../app.css";

const ROWS = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, name: `Person ${i + 1}` }));

/** 400 people in a short box whose compact row is set by `?row=` (px), the way a visual style or a container sets it. */
export function Fixture() {
  const [range, setRange] = useState<Range | null>({ anchor: { row: "p0", col: "1" }, focus: { row: "p0", col: "1" } });
  const row = new URLSearchParams(location.search).get("row");
  return (
    <main style={{ display: "flex", flexDirection: "column", height: 320, ...(row && { "--row-h-compact": `${row}px` }) } as CSSProperties}>
      <PersonDayGrid
        label="October"
        total={ROWS.length}
        rows={ROWS}
        rowKey={r => r.id}
        lead={[{ key: "n", header: "Name", cell: r => r.name, width: "name" }]}
        days={[{ key: "1", label: 1, sub: "" }]}
        tail={[]}
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
