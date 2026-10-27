// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { loadCatalog } from "@console/i18n";
import { Button } from "../button/button";
import { Dialog } from "../dialog";
import { SidePanel } from "./side-panel";
import "../../app.css";

await loadCatalog("ko");
export function Fixture() {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [loading, setLoading] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  return <main>
    <h1>Panel test</h1>
    <Button ref={row} onClick={() => setOpen(true)}>Open peek</Button>
    <Button>Outside control</Button>
    <SidePanel open={open} title="Panel heading" onClose={() => setOpen(false)} returnFocus={() => row.current} loading={loading}>
      <Button onClick={() => setLoading(true)}>Reload</Button>
      <Button onClick={() => setDialog(true)}>Open dialog</Button>
      <Button aria-expanded="true">Expanded picker</Button>
    </SidePanel>
    <Dialog open={dialog} title="Confirm" onClose={() => setDialog(false)}><Button onClick={() => setDialog(false)}>Cancel</Button></Dialog>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
