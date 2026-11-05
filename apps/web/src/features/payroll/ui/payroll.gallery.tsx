// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { useState } from "react";
import type { PayrollRate } from "../api";
import { Section } from "../../../gallery/Section";
import { ReferenceRegister } from "./reference-register";
import { PayGroupSheet } from "./pay-group-sheet";
import { Button } from "../../../ui/button/button";
import { RunHeader } from "./run-page";
import { PayslipDraftView } from "./payslip-draft";
export const order = 154;
// Synthetic gallery data, never a statutory value or an adopted pack.
const galleryRate = (): PayrollRate => ({
  code: "SYNTHETIC", name: t("payroll.reference.item"), value: "0.123456%", status: "ACTIVE",
  effective_from: "2026-01-01", effective_to_exclusive: null, rate_num: null, rate_den: null, floor_won: null, cap_won: null,
  basis: "SYNTHETIC", bearer: "SYNTHETIC", instrument_ko: t("payroll.reference.citation"), article_ko: "SYNTHETIC", promulgation_ko: "SYNTHETIC",
  enforced_on: "2026-01-01", source_url: "https://example.com/payroll-source", retrieved_on: "2026-10-29", provenance_ko: t("payroll.alpha"),
});
export default function PayrollGallery() {
  const [open, setOpen] = useState(false);
  const rate = galleryRate();
  const instrument = { name_ko: rate.instrument_ko, article_ko: rate.article_ko, promulgation_ko: rate.promulgation_ko, enforced_on: rate.enforced_on, url: rate.source_url, retrieved_on: rate.retrieved_on };
  return <Section title={t("payroll.reference.title")}><div className="form">
    <PayslipDraftView data={{ employee_id: "synthetic", employee_name: tg("sample.company"), period: { start: "2026-10-01", end: "2026-10-31" }, pay_date: "2026-11-05", contract: { id: "synthetic", wage_kind: "MONTHLY", amount_won: 1000, monthly_standard_hours: 100, effective_from: rate.effective_from, source_note: tg("sample.company") }, earnings: [{ code: "BASE_PAY", label_ko: t("payroll.employee.wage"), amount_won: 1000, note_ko: t("payroll.alpha") }], gross_won: 1000, minimum_wage_check: { hourly_floor_won: 10, monthly_209h_floor_won: 2090, monthly_standard_hours: 100, effective_hourly_won: 10, passes: true, instrument }, attendance: { period_start: "2026-10-01", period_end: "2026-10-31", worked_days: 0, clock_in_events: 0, clock_out_events: 0 }, issuable: false, blockers: ["ATTENDANCE_INCOMPLETE"], statutory_citations: [] }} />
    <RunHeader entity={tg("sample.company")} run={{ id: "00000000-0000-4000-8000-000000000002", legal_entity_id: "00000000-0000-4000-8000-000000000001", pay_group_id: "00000000-0000-4000-8000-000000000003", source_label: t("payroll.runName"), period_start: "2026-10-01", period_end: "2026-10-31", status: "STAGED", calculation_enabled: false, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }} />
    <Button onClick={() => setOpen(true)}>{t("payroll.setup.add")}</Button>
    {open && <PayGroupSheet entities={[{ id: "00000000-0000-4000-8000-000000000001", name: tg("sample.company") }]} onClose={() => setOpen(false)} onSaved={() => setOpen(false)} />}
    <ReferenceRegister data={{ adopted: true, country_code: "KR", items: [rate, { ...rate, code: "HELD", instrument_ko: "" }] }} />
    <ReferenceRegister data={{ adopted: false, country_code: "US", items: [rate] }} />
    <ReferenceRegister data={{ adopted: true, country_code: "KR", items: [] }} />
  </div></Section>;
}
