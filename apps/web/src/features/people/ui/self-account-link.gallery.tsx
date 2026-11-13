// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Section } from "../../../gallery/Section";
import { SelfAccountLink } from "./self-account-link";

export default function SelfAccountLinkGallery() {
  return <Section title={t("people.account.ownLink")}>
    <SelfAccountLink employeeId="00000000-0000-4000-8000-000000000001" employeeName={t("people.account.confirmNameExample")} />
  </Section>;
}
