// SPDX-License-Identifier: LicenseRef-Proprietary
/**
 * Whether the input method owns this key: a key pressed mid-composition, the Enter that ends a composition (Safari
 * reports it after compositionend, with only key code 229 set), or a "Process" key. A text-entry handler returns on it
 * before acting. Takes a native keyboard event or a React one.
 */
export const isImeKey = (e: { key?: string; keyCode?: number; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } }) =>
  Boolean(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.key === "Process");
