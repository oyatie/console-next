// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Button } from "../button/button";
import { Dialog } from "../dialog";
import { TreeView } from "./tree";
import "../../app.css";

type Place = { id: string; name: string; children: Place[] };
const place = (id: string, name: string, children: Place[] = []): Place => ({ id, name, children });
const ROOTS = [place("company", "Company", [
  place("north", "North site", [place("sales", "Sales", [place("field", "Field sales")]), place("support", "Support")]),
  place("south", "South site", [place("ops", "Operations")]),
])];
// The target pickers list every id as expanded, rows without children included; the scope picker lists only rows with children.
const EVERY = ["company", "north", "sales", "field", "support", "south", "ops"];
const BRANCHES = ["company", "north", "sales", "south"];

/**
 * A tree in a dialog, in its callers' shapes. `?shape=keep` is a target picker: an empty selection is dropped, so the
 * chosen row stays. `?shape=required` leaves keeping it to the tree alone. No shape is the move picker: the pick can be
 * cleared. `?pick=` chooses a row first, `?off=` disables one and `?listed=branches` starts with only the rows that
 * have children listed as expanded.
 */
export function Fixture() {
  const query = new URLSearchParams(location.search);
  const shape = query.get("shape");
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | undefined>(query.get("pick") ?? undefined);
  const [expanded, setExpanded] = useState(new Set(query.get("listed") === "branches" ? BRANCHES : EVERY));
  return (
    <main>
      <Dialog open={open} title="Pick a place" onClose={() => setOpen(false)}>
        <TreeView
          label="Places"
          roots={ROOTS}
          childrenOf={(x) => x.children}
          textValue={(x) => x.name}
          row={(x) => <span>{x.name}</span>}
          selected={picked}
          onSelect={shape === "keep" ? (id) => { if (id) setPicked(id); } : setPicked}
          required={shape !== null}
          expanded={expanded}
          onExpandedChange={setExpanded}
          disabled={new Set(query.getAll("off"))}
        />
        <div className="form__actions"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
      </Dialog>
      <output id="open">{open ? "open" : "closed"}</output>
      <output id="picked">{picked ?? "none"}</output>
      <output id="expanded">{[...expanded].sort().join(" ")}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
