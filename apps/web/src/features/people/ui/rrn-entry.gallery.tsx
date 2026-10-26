// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Section } from "../../../gallery/Section";
import { RrnEntry } from "./rrn-entry";

export default function RrnEntryGallery() {
  return <Section title={t("empCard.rrn.recordTitle")}>
    <RrnEntry employeeId="gallery-person" who={tg("sample.person", { n: 1 })} />
  </Section>;
}
