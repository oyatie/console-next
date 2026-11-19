// SPDX-License-Identifier: LicenseRef-Proprietary
/**
 * Whether the input method owns this key: a key pressed mid-composition, the Enter that ends a composition (Safari
 * reports it after compositionend, with only key code 229 set), or a "Process" key. A text-entry handler returns on it
 * before acting. Takes a native keyboard event or a React one.
 */
export const isImeKey = (e: { key?: string; keyCode?: number; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } }) =>
  Boolean(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.key === "Process");

/**
 * A text-entry element's capture-phase keydown handler. An Escape or Tab pressed while a syllable is composing is the
 * input method's: stopped here, it reaches no handler on the field and no bubble-phase handler or listener above it.
 * Capture handlers on an ancestor and capture listeners on the document or window run first and need their own check.
 * The Escape's default action is cancelled, because a search box clears on it. The Tab's is left alone, so where the
 * browser gives it one, focus moves on as in a native field; cancelled, the composition can stay open and hold every Tab.
 */
export const leaveImeKey = (e: Parameters<typeof isImeKey>[0] & { stopPropagation: () => void; preventDefault: () => void }) => {
  if ((e.key !== "Escape" && e.key !== "Tab") || !isImeKey(e)) return;
  e.stopPropagation();
  if (e.key === "Escape") e.preventDefault();
};
