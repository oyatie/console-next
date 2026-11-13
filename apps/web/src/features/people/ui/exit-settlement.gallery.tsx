// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { SettlementFigures } from "./exit-facts";

export default function ExitSettlementGallery() {
  return <section id="gallery-exit-settlement"><h2>{t("exit.settlement.figures")}</h2>
    <SettlementFigures pkg={{
      id: "gallery-settlement", status: "READY_FOR_APPROVAL", service_days: 1,
      missing_source_fields: [], generated_at: "2026-10-26T00:00:00Z", certification_status: "UNCERTIFIED_DRAFT",
      statutory_basis: {
        severance_eligibility: { outcome: "NOT_ELIGIBLE", reason: "UNDER_SERVICE_YEARS", threshold: { num: 1, den: 1 } },
        calculation_references: { rules: [{ code: "gallery-service-rule", effective_from: "2026-01-01", citation: { instrument_ko: tg("sample.statute"), article_ko: tg("sample.article") } }] },
      },
      insurance_loss_payload: {}, approval_payload: {},
    }} />
  </section>;
}
