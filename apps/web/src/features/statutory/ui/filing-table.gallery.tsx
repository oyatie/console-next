// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { FilingTask } from "../../../reference/statutory/api";
import { FilingTable } from "./filing-table";

export default function FilingTableGallery() {
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const task: FilingTask = {
    event_id: "gallery-event", employee_id: "gallery-person", name: tg("sample.person", { n: 1 }), employee_number: "HR-001",
    kind: "ACQUIRE", insurer: "NPS", effective_date: "2026-09-01", legal_entity_id: null,
    workplace_id: null, workplace_name: tg("sample.site"), due_date: "2026-09-15", due_in_days: 3, deadline_status: "HOLD",
    version: 1, completed_on: null, receipt_number: null, loss_code: null, detail: null,
    opens_on: "2026-09-01", target_on: "2026-09-01", due_on: "2026-09-15", dates: null,
    basis: null, applicability: { status: "APPLIES" }, applicability_facts: {}, can_record_sensitive_facts: false, birth_date_known: false,
    state: "PENDING", record_action: null, not_applicable_reason: null, not_applicable_options: [],
    total_remuneration_won: null, is_request: false, acquired_on: null, loss_options: [],
  };
  const rows = task.name.includes(search) || task.employee_number!.includes(search) ? [task] : [];
  return <section id="gallery-filings"><h2>{t("statutory.insurance")}</h2>
    <FilingTable rows={rows} total={rows.length} search={search} onFind={setSearch}
      onRecord={() => setAction(t("statutory.record"))} onRequest={() => setAction(t("statutory.futureRequest"))}
      onUndo={() => setAction(t("statutory.undo"))} undoing={false} />
    <output>{action}</output>
  </section>;
}
