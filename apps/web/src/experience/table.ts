// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MessageId } from "@console/i18n";

export const experiences = [
  { id: "baseline", label: "account.experience.baseline", listing: "listed" },
  // Offered while it is built, so it can be judged in the running app; the chooser says it is a preview.
  { id: "control-room", label: "account.experience.controlRoom", listing: "preview" },
  // Not offered until its screens exist. A stored choice still loads it, which the gallery and the tests rely on.
  { id: "warm-clear", label: "account.experience.warmClear", listing: "unlisted" },
] as const satisfies readonly { id: string; label: MessageId; listing: "listed" | "preview" | "unlisted" }[];

/** What the chooser offers: every listed or preview style, and the style in force even when it is unlisted. */
export const offeredExperiences = (current: string) => experiences.filter(experience => experience.listing !== "unlisted" || experience.id === current);

export function resolveExperience(id?: string) {
  return experiences.find(experience => experience.id === id) ?? experiences[0];
}
