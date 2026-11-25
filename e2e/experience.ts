// SPDX-License-Identifier: LicenseRef-Proprietary
import type { PlaywrightTestOptions } from "@playwright/test";
import { experiences, resolveExperience } from "../apps/web/src/experience/table";
import { EXPERIENCE_KEY } from "../apps/web/src/lib/prefs";
import { PORTS } from "./slot";

/** Classic-look pins (pixels, Classic-only layout and words, Classic phone layouts) are tagged `@baseline`; the mock config runs them in its `baseline` project. */
export const BASELINE = /@baseline/;

/**
 * The mock suite's storage seed, for `test.use({ storageState })`: `id` stored on the device, which public/prefs.js
 * paints before the first frame. Stored with no source it reads as a personal choice, so it also outranks an
 * organization default. No id stores nothing, so the shipped default runs. The mock config builds its own seed
 * here, so a spec that names a style keeps every origin the config sets.
 */
export function experienceState(id?: string) {
  if (!id) return { cookies: [], origins: [] };
  if (!experiences.some(experience => experience.id === id)) throw new Error(`unknown experience "${id}": expected ${experiences.map(experience => experience.id).join(", ")}`);
  return { cookies: [], origins: [{ origin: `http://localhost:${PORTS.web}`, localStorage: [{ name: EXPERIENCE_KEY, value: id }] }] };
}

/**
 * The style a test's page paints, read from the `storageState` fixture the test was given (the project's seed, or a
 * describe's `test.use`), not from the page: the seeded id, else the shipped default.
 */
export function seededExperience(state: PlaywrightTestOptions["storageState"]) {
  if (typeof state === "string") throw new Error("seededExperience reads an inline storage seed, not a file");
  return resolveExperience(state?.origins.flatMap(origin => origin.localStorage).find(item => item.name === EXPERIENCE_KEY)?.value).id;
}
