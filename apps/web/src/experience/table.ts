// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MessageId } from "@console/i18n";

export const experiences = [
  { id: "baseline", label: "account.experience.baseline" },
] as const satisfies readonly { id: string; label: MessageId }[];

export function resolveExperience(id?: string) {
  return experiences.find(experience => experience.id === id) ?? experiences[0];
}
