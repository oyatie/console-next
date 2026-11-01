// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Section } from "../../../gallery/Section";
import { HeadcountBasis } from "../../../reference/org/ui/headcount-basis";
import { FirstRun } from "./first-run";
import { StructureKeys } from "./structure-keys";

export const order = 154;
export default function StructureCopyGallery() {
  return <Section title={t("structure.title")}>
    <FirstRun />
    <div className="row"><HeadcountBasis /><StructureKeys view="outline" /></div>
  </Section>;
}
