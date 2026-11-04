// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState, type RefObject } from "react";

const FOCUSABLE = 'a[href], area[href], audio[controls], button:not([disabled]), embed, iframe, input:not([disabled]):not([type="hidden"]), object, select:not([disabled]), summary, textarea:not([disabled]), video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

/**
 * React Aria hides non-modal ComboBox surroundings even though their controls remain focusable.
 * Expose only focusable-bearing subtrees; pre-hidden content and static decoration stay hidden.
 * App-owned hiding during an open list is deferred until close; removing it cancels restoration.
 */
export function useNonModalSurroundings(input: RefObject<HTMLInputElement | null>, popover: RefObject<HTMLDivElement | null>) {
  const [open, setOpen] = useState(false);
  const hiddenBeforeOpen = useRef(new Set<Element>());
  const restoreHidden = useRef(new Set<Element>());
  const outsideObserver = useRef<MutationObserver>(null);
  const restoreOutside = () => {
    for (const el of restoreHidden.current) el.setAttribute("aria-hidden", "true");
    restoreHidden.current.clear();
  };
  useEffect(() => {
    if (!open) return;
    const inputEl = input.current!;
    const popoverEl = popover.current!;
    const body = inputEl.ownerDocument.body;
    const preserved = [...body.querySelectorAll<HTMLElement>("[inert]")];
    // The list closes before focus leaves, so keep its non-modal surroundings exposed to assistive technology.
    const expose = (el: Element) => {
      if (el.getAttribute("aria-hidden") !== "true" || hiddenBeforeOpen.current.has(el)) return;
      if (!el.contains(inputEl) && !el.contains(popoverEl) && !el.matches(FOCUSABLE) && !el.querySelector(FOCUSABLE)) return;
      restoreHidden.current.add(el);
      // Keep a value for an app-owned removal to mutate, so the observer can cancel restoration.
      el.setAttribute("aria-hidden", "false");
    };
    for (const el of body.querySelectorAll('[aria-hidden="true"]')) expose(el);
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        const el = change.target as Element;
        if (change.oldValue === "false" && el.getAttribute("aria-hidden") !== "true") restoreHidden.current.delete(el);
        expose(el);
      }
    });
    outsideObserver.current = observer;
    observer.observe(body, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ["aria-hidden"] });
    // A picker inside a Sheet: when the Sheet itself unmounts (Back, route change) its overlay's inert must not return.
    const host = input.current!.closest('[role="dialog"]');
    return () => {
      observer.disconnect();
      if (outsideObserver.current === observer) outsideObserver.current = null;
      const restore = () => { for (const el of preserved) el.inert = true; };
      // A rapid reopen must snapshot the original restrictions before any microtask runs.
      restore();
      // On unmount, React Aria's child cleanup runs after ours and clears inert with aria-hidden.
      queueMicrotask(() => { if (!host || host.isConnected) restore(); });
    };
  }, [open, input, popover]);
  return (next: boolean) => {
    if (next) {
      hiddenBeforeOpen.current = new Set(input.current!.ownerDocument.querySelectorAll('[aria-hidden="true"]'));
    } else {
      outsideObserver.current?.disconnect();
      restoreOutside();
    }
    setOpen(next);
  };
}
