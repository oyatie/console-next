// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { LifecycleCase } from "../api/lifecycle-trail";
import { ExitBoard } from "./exit-board";

export default function ExitBoardGallery() {
  const rows = [
    ["approval", "REC", t("exit.step.HR_CONFIRMED")], ["handover", "BACK", t("exit.board.leg.handover")],
    ["settlement", "PAY", t("exit.deadline.FINAL_PAY")], ["access", "ACC", t("lifecycle.trail.accessReview")],
    ["documents", "DOC", t("lifecycle.trail.documents")], ["filing", "FIL", t("lifecycle.trail.filing")],
    ["settlement", "DOC", t("exit.board.leg.settlement"), "payroll"],
  ];
  const value: LifecycleCase = {
    id: "gallery-exit", employee_id: "gallery-person", kind: "EXIT", state: "CLOSED", trigger_id: null,
    effective_date: "2026-10-26", linked_case_id: null, cancellation_reason: null, version: 1,
    items: rows.map(([exit_leg, kind, label, payroll], i) => ({
      id: `gallery-exit-${i}`, case_id: "gallery-exit", item_key: `gallery-register-${i}`, kind: kind!, label: label!, label_key: null,
      owner_line: "hr_basic.edit", status: "DONE_ATTESTED", status_code: null, opens_on: "2026-10-27", opens_in_days: 0,
      due_date: "2026-11-09", due_in_days: 3, due_disposition: "KNOWN", due_rule_ref: "gallery-register",
      opens_rule_ref: null, basis: { exit_leg, payroll_pending: payroll === "payroll" }, blocks_close: true, observed_ref: null, exception_id: null,
      filing_obligation_id: null, version: 1,
    })),
  };
  return <section id="gallery-exit-board"><h2>{t("exit.board.board")}</h2><ExitBoard value={value} lastWorkingDay={value.effective_date} /></section>;
}
