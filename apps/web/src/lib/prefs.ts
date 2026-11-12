// SPDX-License-Identifier: LicenseRef-Proprietary
// The bundle's side of public/prefs.js, which puts the theme (stored, else the system's) and the stored experience on
// <html> before the first paint and publishes the values it accepts. A test keeps the theme key and values below
// equal to the ones it applies.
export const THEME_KEY = "console.theme";
export const THEMES = ["light", "dark"] as const;
