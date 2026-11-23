// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { offeredExperiences, resolveExperience } from "../../experience/table";

export function experienceChoiceOptions(rawValue: unknown) {
  const current = resolveExperience(typeof rawValue === "string" ? rawValue : undefined).id;
  const options = offeredExperiences(current).map(experience => ({
    value: experience.id,
    label: experience.listing === "preview"
      ? t("account.experience.preview", { style: t(experience.label) })
      : t(experience.label),
  }));
  return { current, options };
}
