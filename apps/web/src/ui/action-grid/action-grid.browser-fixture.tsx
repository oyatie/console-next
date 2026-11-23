// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActionGrid } from "./action-grid";

export function Fixture() {
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState(true);
  return <main aria-label="Grid test">
    <output aria-label="Picked">{picked.join(" ")}</output>
    {open && <ActionGrid label="Acts" head={null} onPick={id => setPicked(all => [...all, id])} onClose={() => setOpen(false)}
      groups={[{ title: "Place", items: [
        { id: "move", icon: null, title: "Move", desc: "Move the person", keys: "M" },
        { id: "exit", icon: null, title: "Exit", desc: "Report an exit", keys: "⌘X" },
      ] }]} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
