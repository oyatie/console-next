// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Section } from "../../../gallery/Section";
import { SelfBindingReview } from "./self-binding-review";

export default function SelfBindingReviewGallery() {
  return <Section title={t("people.account.bindingReview")}><SelfBindingReview id="00000000-0000-4000-8000-000000000001" /></Section>;
}
