// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Section } from "../../gallery/Section";
import { ExperienceChooser } from "./experience-chooser";

export const order = 16;

export default function ExperienceChooserGallery() {
  return <Section title={t("account.experience")}><ExperienceChooser id="gallery-experience" /></Section>;
}
