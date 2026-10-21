// Single-key shortcuts of a long table, live only while focus is inside its region (KWCAG 2.2 6.1.4 / WCAG
// 2.1.4: no page-wide single-key shortcut). Listened for on the document in the capture phase, so they run
// before React Aria's type-to-select (which would jump to a row starting with "k").

/** Typing goes to text entry; a focused checkbox or row is not text entry. */
export const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) || (el instanceof HTMLInputElement && !/^(checkbox|radio|button)$/.test(el.type)));

export type RowKeyHandlers = {
  /** `/`: focus the in-app search. */
  find?: () => void;
  /** J/K move between rows like ↓/↑; O opens the focused row. Keys by position (`code`), so a Korean layout works too. */
  rows?: { grid: () => HTMLElement | null; onOpen?: (id: string) => void };
};

/** The row id (React Aria's `data-key`) of the row holding `el`, if any. */
export const rowIdOf = (el: EventTarget | null) => (el instanceof Element ? el.closest("[role=row][data-key]")?.getAttribute("data-key") ?? null : null);

/** Adds the region's shortcuts; returns the remover. */
export function listenRowKeys(region: HTMLElement, h: RowKeyHandlers) {
  const key = (e: KeyboardEvent) => {
    if (!region.contains(e.target as Node) || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || editable(e.target)) return;
    const stop = () => (e.preventDefault(), e.stopPropagation());
    if (e.key === "/" && h.find) return void (stop(), h.find());
    const grid = h.rows?.grid();
    if (!h.rows || e.shiftKey || !grid?.contains(e.target as Node)) return;
    const arrow = e.code === "KeyJ" ? "ArrowDown" : e.code === "KeyK" ? "ArrowUp" : null;
    if (arrow) {
      stop();
      // A held key repeats like a held arrow; React Aria moves focus on its own (bubbling) keydown.
      e.target!.dispatchEvent(new KeyboardEvent("keydown", { key: arrow, code: arrow, bubbles: true, cancelable: true }));
      return;
    }
    const id = rowIdOf(e.target);
    if (e.code === "KeyO" && id && h.rows.onOpen) return void (stop(), h.rows.onOpen(id));
  };
  document.addEventListener("keydown", key, true);
  return () => document.removeEventListener("keydown", key, true);
}
