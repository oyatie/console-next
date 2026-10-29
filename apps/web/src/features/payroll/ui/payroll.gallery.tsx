// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { PayrollRate } from "../api";
import { Section } from "../../../gallery/Section";
import { ReferenceRegister } from "./reference-register";
export const order = 154;
// Synthetic gallery data, never a statutory value or an adopted pack.
const galleryRate = (): PayrollRate => ({
  code: "SYNTHETIC", name: t("payroll.reference.item"), value: "0.123456%", status: "ACTIVE",
  effective_from: "2026-01-01", effective_to_exclusive: null, rate_num: null, rate_den: null, floor_won: null, cap_won: null,
  basis: "SYNTHETIC", bearer: "SYNTHETIC", instrument_ko: t("payroll.reference.citation"), article_ko: "SYNTHETIC", promulgation_ko: "SYNTHETIC",
  enforced_on: "2026-01-01", source_url: "https://example.com/payroll-source", retrieved_on: "2026-10-29", provenance_ko: t("payroll.alpha"),
});
export default function PayrollGallery() {
  const rate = galleryRate();
  return <Section title={t("payroll.reference.title")}><div className="form">
    <ReferenceRegister data={{ adopted: true, country_code: "KR", items: [rate, { ...rate, code: "HELD", instrument_ko: "" }] }} />
    <ReferenceRegister data={{ adopted: false, country_code: "US", items: [rate] }} />
    <ReferenceRegister data={{ adopted: true, country_code: "KR", items: [] }} />
  </div></Section>;
}
