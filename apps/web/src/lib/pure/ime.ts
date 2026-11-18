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
 * input method's: stopped here, at React's root listener, it reaches no handler on the field or above it, native
 * listeners included. Its default action stays, so the Tab commits the syllable and moves on as in a native field.
 */
export const leaveImeKey = (e: Parameters<typeof isImeKey>[0] & { stopPropagation: () => void }) => {
  if ((e.key === "Escape" || e.key === "Tab") && isImeKey(e)) e.stopPropagation();
};
