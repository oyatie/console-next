// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { loadCatalog } from "@console/i18n";
import { Button } from "../button/button";
import { Dialog } from "../dialog";
import { Sheet } from "../sheet/sheet";
import { SidePanel } from "./side-panel";
import "../../app.css";
import s from "./side-panel.browser-fixture.module.css";

await loadCatalog("ko");
export function Fixture() {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [size, setSize] = useState<"sm" | "md">("md");
  const [large, setLarge] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  return <main className={`shell ${s.fixture}`} data-menu="open">
    <nav className={`rail ${s.rail}`} aria-label="Test menu" />
    <h1>Panel test</h1>
    <Button ref={row} onClick={() => setOpen(true)}>Open peek</Button>
    <Button>Outside control</Button>
    <Button onClick={() => { setSize("sm"); setDialog(true); }}>Small dialog</Button>
    <Button onClick={() => { setSize("md"); setDialog(true); }}>Medium dialog</Button>
    <Button onClick={() => { setLarge(false); setSheet(true); }}>Default sheet</Button>
    <Button onClick={() => { setLarge(true); setSheet(true); }}>Large sheet</Button>
    <SidePanel open={open} title="Panel heading" onClose={() => setOpen(false)} returnFocus={() => row.current} loading={loading}>
      <Button onClick={() => setLoading(true)}>Reload</Button>
      <Button onClick={() => setDialog(true)}>Open dialog</Button>
      <Button aria-expanded="true">Expanded picker</Button>
    </SidePanel>
    <Dialog open={dialog} size={size} title="Confirm" onClose={() => setDialog(false)}><Button onClick={() => setDialog(false)}>Cancel</Button></Dialog>
    <Sheet open={sheet} size={large ? "lg" : undefined} title="Command" onClose={() => setSheet(false)} consequence="Consequence" actions={<Button onClick={() => setSheet(false)}>Cancel</Button>}>Body</Sheet>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
