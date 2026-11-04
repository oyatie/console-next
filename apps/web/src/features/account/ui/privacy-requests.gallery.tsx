// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Section } from "../../../gallery/Section";
import { PrivacyRequestsView } from "./privacy-requests";
import { PrivacyRequestForm } from "./privacy-request";

export default function PrivacyRequestsGallery() {
  return <><Section title={t("account.privacy.file")}><PrivacyRequestForm onFiled={() => {}} options={{
    subject_user_id: "00000000-0000-4000-8000-000000000001", as_of: "2026-11-05",
    controllers: [{ code: "OPERATOR" }],
    kinds: [{ code: "ACCESS", due_on: "2026-11-15", without_delay: false }],
    detail_max_length: 2000, reply_email_masked: null,
  }} /></Section><Section title={t("account.privacy.title")}><PrivacyRequestsView items={[{
    id: "rights-gallery", receipt_no: "RR-001", controller_label: tg("blocker.ceoRole"),
    kinds: [{ code: "ACCESS", label: tg("reason.label") }], detail: tg("blocker.routeBody"),
    received_at: "2026-11-01T00:00:00Z", status: { code: "RECEIVED", label: t("account.privacy.received"), tone: "info" },
    clock: { due_at: "2026-11-11T00:00:00Z", days_left: 6, severity: "due" },
    outcomes: [], notified_at: null, objection_method: null, retention_notice: null,
  }]} /></Section></>;
}
