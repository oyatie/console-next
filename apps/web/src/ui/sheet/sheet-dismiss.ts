// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useBackBlock } from "../../lib/react/navigation-block";

const FORM_CONTROL = "form, .form, input, select, textarea, [contenteditable=true]";
const SEARCH_CONTROL = 'input[type="search"], [role="searchbox"]';

/** One dismissal contract for modal and docked sheets. */
export function useSheetDismiss<E extends HTMLElement>({ onClose, pending, dirty: dirtyProp }: { onClose: () => void; pending?: boolean; dirty?: boolean }) {
  const ref = useRef<E>(null);
  const controlled = dirtyProp !== undefined;
  const [changed, setChanged] = useState(false);
  const [armed, setArmedState] = useState(false);
  const armedRef = useRef(false);
  const dirty = controlled ? Boolean(dirtyProp) : changed;
  const arm = useCallback(() => {
    armedRef.current = true;
    setArmedState(true);
  }, []);
  const disarm = useCallback(() => {
    armedRef.current = false;
    setArmedState(false);
  }, []);
  const isTop = useCallback(() => {
    const layers = document.querySelectorAll("[data-sheet-layer]");
    return layers.length === 0 || layers.item(layers.length - 1) === ref.current;
  }, []);
  const requestClose = useCallback(() => {
    if (pending || !isTop()) return;
    if (dirty && !armedRef.current) return arm();
    disarm();
    onClose();
  }, [pending, onClose, dirty, isTop, arm, disarm]);
  const onInput = (event: FormEvent) => {
    if (!controlled && !(event.target as Element).matches(SEARCH_CONTROL)) setChanged(true);
    disarm();
  };
  const onBackdrop = () => {
    if (!isTop()) return;
    if (controlled || dirty || ref.current?.querySelector(FORM_CONTROL)) {
      if (dirty) arm();
      return;
    }
    requestClose();
  };

  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return void (armedRef.current && disarm());
      const target = event.target as HTMLElement;
      const ownDialog = ref.current?.querySelector('[role="dialog"]');
      const targetDialog = target.closest?.('[role="dialog"]');
      if (event.defaultPrevented || event.isComposing || target.closest?.('[role="listbox"]') || target.getAttribute?.("aria-expanded") === "true"
        || (targetDialog && targetDialog !== ownDialog) || !isTop()) return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    };
    layer.addEventListener("keydown", onKeyDown);
    return () => layer.removeEventListener("keydown", onKeyDown);
  }, [isTop, requestClose, disarm]);

  const blockBack = useCallback(() => {
    if (!isTop()) return false;
    if (pending) return true;
    requestClose();
    return true;
  }, [isTop, pending, requestClose]);
  useBackBlock(dirty, blockBack);

  return { ref, dirty, armed, requestClose, onInput, onBackdrop };
}
