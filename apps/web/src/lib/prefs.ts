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
