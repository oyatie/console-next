// SPDX-License-Identifier: LicenseRef-Proprietary
// The bundle's side of public/prefs.js, which puts the theme (stored, else the system's) and the stored experience on
// <html> before the first paint and publishes the values it accepts. A test keeps the theme key and values below
// equal to the ones it applies.
export const THEME_KEY = "console.theme";
export const THEMES = ["light", "dark"] as const;
export const EXPERIENCE_KEY = "console.experience";

// Single-key shortcuts on this device (WCAG 2.1.4): "off" is the one stored value. The boot script has no part in it;
// the key handlers read it at key time. Absent, or storage that refuses the read, is on.
export const SINGLE_KEYS_KEY = "console.singleKeys";
export function singleKeysOn() {
  try { return localStorage.getItem(SINGLE_KEYS_KEY) !== "off"; } catch { return true; }
}
// A storage event reaches only the other tabs, so this tab's readers hear the change through this one.
const SINGLE_KEYS_CHANGED = "console:single-keys";
/** Stores the choice and tells this tab's readers. Throws when storage refuses the write, and then tells no one. */
export function setSingleKeys(on: boolean) {
  if (on) localStorage.removeItem(SINGLE_KEYS_KEY);
  else localStorage.setItem(SINGLE_KEYS_KEY, "off");
  window.dispatchEvent(new Event(SINGLE_KEYS_CHANGED));
}
/** Calls `change` when the choice changes here or in another tab; returns the unsubscribe. */
export function subscribeSingleKeys(change: () => void) {
  const storage = (e: StorageEvent) => { if (e.key === SINGLE_KEYS_KEY || e.key === null) change(); };
  window.addEventListener("storage", storage);
  window.addEventListener(SINGLE_KEYS_CHANGED, change);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(SINGLE_KEYS_CHANGED, change);
  };
}
