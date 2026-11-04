// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useBackBlock } from "../../lib/react/navigation-block";

const FORM_CONTROL = "form, .form, input, select, textarea, [contenteditable=true], [data-form-value]";
const VALUE_CONTROL = 'input:not([type="search"]):not([type="file"]):not([role="searchbox"]):not([role="combobox"]), select, textarea, [contenteditable="true"], [data-form-value]';
type OpeningValues = { values: Map<string, string>; anonymous: WeakMap<Element, string>; next: number };

function controlValue(control: Element) {
  const committed = control.getAttribute("data-form-value");
  if (committed !== null) return committed;
  if (control instanceof HTMLInputElement)
    return control.type === "checkbox" || control.type === "radio" ? `${control.checked}:${control.value}` : control.value;
  if (control instanceof HTMLSelectElement)
    return control.multiple ? JSON.stringify([...control.selectedOptions].map(option => option.value)) : control.value;
  if (control instanceof HTMLTextAreaElement) return control.value;
  return control.getAttribute("contenteditable") === "true" ? (control.textContent ?? "") : "";
}

function readValues(root: Element, opening: OpeningValues) {
  const repeated = new Map<string, number>();
  const parts: string[] = [];
  let dirty = false;
  for (const control of root.querySelectorAll(VALUE_CONTROL)) {
    const name = control.getAttribute("name");
    const labelled = control.getAttribute("aria-label") ?? control.querySelector("label")?.textContent?.replace(/\*\s*$/, "").trim();
    const input = control instanceof HTMLInputElement ? `:${control.type}:${control.type === "checkbox" || control.type === "radio" ? control.value : ""}` : "";
    const identity = labelled && control.hasAttribute("data-form-value")
      ? `form:${labelled}`
      : control.id ? `id:${control.id}` : name ? `name:${control.tagName}:${name}${input}` : labelled ? `aria:${control.tagName}:${labelled}` : null;
    let key = identity;
    if (identity) {
      const occurrence = repeated.get(identity) ?? 0;
      repeated.set(identity, occurrence + 1);
      key = `${identity}:${occurrence}`;
    } else {
      key = opening.anonymous.get(control) ?? `anonymous:${opening.next++}`;
      opening.anonymous.set(control, key);
    }
    const value = controlValue(control);
    parts.push(`${key}=${value}`);
    if (!opening.values.has(key)) opening.values.set(key, value);
    else if (opening.values.get(key) !== value) dirty = true;
  }
  return { dirty, snapshot: parts.join("\n") };
}

/** One dismissal contract for modal and docked sheets. */
export function useSheetDismiss<E extends HTMLElement>({ onClose, pending, dirty: dirtyProp, nativeEscape }: { onClose: () => void; pending?: boolean; dirty?: boolean; nativeEscape?: boolean }) {
  const ref = useRef<E>(null);
  const controlled = dirtyProp !== undefined;
  const [changed, setChanged] = useState(false);
  const opening = useRef<OpeningValues>({ values: new Map(), anonymous: new WeakMap(), next: 0 });
  const lastSnapshot = useRef<string | null>(null);
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
  const refresh = useCallback(() => {
    if (controlled || !ref.current) return;
    const { dirty: next, snapshot } = readValues(ref.current, opening.current);
    if (lastSnapshot.current !== null && lastSnapshot.current !== snapshot && armedRef.current) disarm();
    lastSnapshot.current = snapshot;
    setChanged(current => current === next ? current : next);
  }, [controlled, disarm]);
  useLayoutEffect(refresh);
  useEffect(() => {
    const layer = ref.current;
    if (controlled || !layer) return;
    refresh();
    const observer = new MutationObserver(() => refresh());
    observer.observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-form-value"] });
    return () => observer.disconnect();
  }, [controlled, refresh]);
  const onInput = (_event: FormEvent) => {
    refresh();
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
      const ownDialog = layer.matches('[role="dialog"]') ? layer : layer.querySelector('[role="dialog"]');
      const targetDialog = target.closest?.('[role="dialog"]');
      if (event.defaultPrevented || event.isComposing || target.closest?.('[role="listbox"]') || target.getAttribute?.("aria-expanded") === "true"
        || (targetDialog && targetDialog !== ownDialog) || !isTop()) return;
      if (pending) return;
      if (dirty && !armedRef.current) {
        event.preventDefault();
        event.stopPropagation();
        arm();
      } else if (nativeEscape) {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }
    };
    layer.addEventListener("keydown", onKeyDown);
    return () => layer.removeEventListener("keydown", onKeyDown);
  }, [isTop, requestClose, disarm, pending, dirty, nativeEscape, arm]);

  const guarded = Boolean(pending || (dirty && !armed));
  const blockBack = useCallback(() => {
    if (!isTop()) return false;
    if (pending) return true;
    if (dirty && !armedRef.current) {
      arm();
      return true;
    }
    return false;
  }, [isTop, pending, dirty, arm]);
  const shouldCloseOnPop = useCallback(() => !pending && isTop(), [pending, isTop]);
  const closeAfterPop = useCallback(() => {
    if (!ref.current?.isConnected) return;
    disarm();
    onClose();
  }, [disarm, onClose]);
  useBackBlock(guarded, dirty, blockBack, shouldCloseOnPop, closeAfterPop);

  return { ref, dirty, armed, requestClose, onInput, onBackdrop };
}
