// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { loadCatalog } from "@console/i18n";
import { installDirtyTracker } from "../../experience/dirty-guard";
import { Button } from "../button/button";
import { FlexibleColumns } from "./flexible-columns";
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

/** A list row that opens a record column whose body is an inline form, and a related column with no form. */
export function Fixture() {
  const [open, setOpen] = useState(false);
  const [related, setRelated] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  return (
    <main>
      <FlexibleColumns
        list={<Button ref={row} data-row-id="a" onClick={() => setOpen(true)}>Row A</Button>}
        record={open && { id: "a", label: "Record", onClose: () => setOpen(false), returnFocus: () => row.current,
          children: <><NoteForm /><Button onClick={() => setRelated(true)}>Open related</Button></> }}
        related={related && { id: "r", label: "Related", onClose: () => setRelated(false), children: <Button>Related action</Button> }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
