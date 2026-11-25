// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { loadCatalog } from "@console/i18n";
import { installDirtyTracker } from "../../experience/dirty-guard";
import { Button } from "../button/button";
import { FlexibleColumns } from "../flexible-columns/flexible-columns";
import { PaneGrid } from "./pane-grid";
import "../../app.css";

await loadCatalog("ko");
// The app shell installs the tracker when it mounts.
installDirtyTracker(document);

function NoteForm() {
  const [note, setNote] = useState("");
  const [urgent, setUrgent] = useState(false);
  return (
    // The screen refuses every save, so nothing typed here is ever saved.
    <form aria-label="Note" onSubmit={e => e.preventDefault()}>
      <input aria-label="Note text" value={note} onChange={e => setNote(e.target.value)} />
      <label><input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} />Urgent</label>
      <Button>Check spelling</Button>
      <Button type="submit">Save</Button>
    </form>
  );
}

// The same screen in either side-pane component: `?component=flexible-columns`, else the pane grid.
const columns = new URLSearchParams(location.search).get("component") === "flexible-columns";

/** A list row that opens a record pane whose body is an inline form, and a related pane with no form. */
export function Fixture() {
  const [open, setOpen] = useState(false);
  const [related, setRelated] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  const list = <Button ref={row} data-row-id="a" onClick={() => setOpen(true)}>Row A</Button>;
  const record = open && { id: "a", label: "Record", onClose: () => setOpen(false), returnFocus: () => row.current,
    children: <><NoteForm /><Button onClick={() => setRelated(true)}>Open related</Button></> };
  const relatedPane = related && { id: "r", label: "Related", onClose: () => setRelated(false), children: <Button>Related action</Button> };
  return (
    <main>
      {columns
        ? <FlexibleColumns list={list} record={record} related={relatedPane} />
        : <PaneGrid main={list} record={record} related={relatedPane} />}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
