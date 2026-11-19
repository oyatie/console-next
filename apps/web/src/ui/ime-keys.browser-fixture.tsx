// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Palette } from "./palette/palette";
import { PersonDayGrid } from "./person-day-grid/person-day-grid";
import "../app.css";

const ROWS = [{ id: "a", name: "Yoon Hajun" }];

/** One text-entry handler per page (`?case=`): the palette is modal, so the two cannot share a document. */
export function Fixture() {
  const [acted, setActed] = useState(0);
  const [committed, setCommitted] = useState(0);
  const [value, setValue] = useState<string | null>("8");
  if (new URLSearchParams(location.search).get("case") === "palette") return (
    <Palette
      open
      onClose={() => undefined}
      label="Find a person"
      query="yoon"
      onQuery={() => undefined}
      placeholder="Name"
      sections={[{ id: "people", title: "People", items: [{ id: "p1", text: "Yoon Hajun", title: "Yoon Hajun" }] }]}
      onAction={() => setActed(n => n + 1)}
      foot={<output id="acted">{acted}</output>}
    />
  );
  return (
    <main>
      <PersonDayGrid
        label="October"
        total={1}
        rows={ROWS}
        rowKey={r => r.id}
        lead={[{ key: "n", header: "Name", cell: r => r.name, width: "name" }]}
        days={[{ key: "1", label: 1, sub: "" }]}
        tail={[]}
        cell={() => "8"}
        look={() => undefined}
        describe={r => `${r.name} day 1`}
        range={{ anchor: { row: "a", col: "1" }, focus: { row: "a", col: "1" } }}
        onRange={() => undefined}
        editing={value === null ? null : { value, cell: { row: "a", col: "1" } }}
        onEdit={setValue}
        onCommit={() => setCommitted(n => n + 1)}
        onKey={() => false}
      />
      <output id="committed">{committed}</output>
      <output id="open">{value === null ? "closed" : "open"}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
