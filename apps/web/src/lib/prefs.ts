// SPDX-License-Identifier: LicenseRef-Proprietary
// The bundle's side of public/prefs.js, which puts the stored theme and experience on <html> before the first paint
// and publishes the values it accepts. A test keeps the theme key and values below equal to the ones it applies.
type Prefs = Record<"theme" | "experience", { key: string; values: readonly string[] }>;

export const THEME_KEY = "console.theme";
export const THEMES = ["light", "dark"] as const;

/** The experience ids the boot script accepts: the one list of them. Empty when it did not run. */
export const knownExperiences = (): readonly string[] => (globalThis as { consolePrefs?: Prefs }).consolePrefs?.experience.values ?? [];
