// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MessageId } from "@console/i18n";

type ExperienceListing = "listed" | "preview" | "unlisted";

type ExperienceEntry = {
  readonly id: "baseline" | "console" | "warm-clear";
  readonly label: MessageId;
  readonly listing: ExperienceListing;
};

export const experiences: readonly [ExperienceEntry, ...ExperienceEntry[]] = [
  { id: "baseline", label: "account.experience.baseline", listing: "listed" },
  // Listed alongside Classic so users can switch cleanly without a preview badge.
  { id: "console", label: "account.experience.console", listing: "listed" },
  // Not offered until its screens exist. A stored choice still loads it, which the gallery and the tests rely on.
  { id: "warm-clear", label: "account.experience.warmClear", listing: "unlisted" },
];

/** What the chooser offers: every listed or preview style, and the style in force even when it is unlisted. */
export const offeredExperiences = (current: string) => experiences.filter(experience => experience.listing !== "unlisted" || experience.id === current);

const DEFAULT_EXPERIENCE: ExperienceEntry = experiences[1]!;

export function resolveExperience(id?: string): ExperienceEntry {
  return experiences.find(experience => experience.id === id) ?? DEFAULT_EXPERIENCE;
}
