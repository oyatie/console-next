// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef } from "react";
import { pick, type KeyId } from "../pure/keys";
import { editable } from "../../ui/long-table/row-keys";

/**
 * Binds the screen's shortcuts from the keymap. One guard for all of them: a key the input method is composing is left
 * alone; a field keeps its keys unless the binding says otherwise; a page key waits while a dialog is open unless it
 * says otherwise; a region key needs focus inside the element `region` returns. A matched key's default is prevented.
 * An earlier `preventDefault` does not stop a binding: a text field prevents Enter to stop the form submitting, and
 * ⌘Enter from that field must still save.
 */
export function useKeys(
  handlers: { [K in KeyId]?: (e: KeyboardEvent, chord: string) => void },
  { region, capture = false }: { region?: () => Element | null | undefined; capture?: boolean } = {},
) {
  const latest = useRef({ handlers, region });
  useEffect(() => void (latest.current = { handlers, region }));
  useEffect(() => {
    const listen = (e: KeyboardEvent) => {
      if (e.isComposing || e.key === "Process") return;
      const { handlers: live, region: within } = latest.current;
      const inside = within?.();
      const hit = pick(e, Object.keys(live) as KeyId[], {
        typing: editable(e.target),
        dialog: document.querySelector("[role=dialog], [role=alertdialog]") !== null,
        inRegion: !!inside && e.target instanceof Node && inside.contains(e.target),
      });
      if (!hit) return;
      e.preventDefault();
      live[hit.id]?.(e, hit.chord);
    };
    document.addEventListener("keydown", listen, capture);
    return () => document.removeEventListener("keydown", listen, capture);
  }, [capture]);
}
