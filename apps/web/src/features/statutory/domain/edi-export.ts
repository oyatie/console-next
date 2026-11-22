// SPDX-License-Identifier: LicenseRef-Proprietary
import type { FilingTask } from "@console/api/pending";
import { csvCell } from "../../../lib/csv-cell";

type EdiExportLabels = {
  headers: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  formatInsurer?: (code: string) => string;
  formatKind?: (code: string) => string;
};

const DEFAULT_LABELS: EdiExportLabels = {
  headers: [
    "insurer",
    "kind",
    "workplace_name",
    "employee_number",
    "name",
    "effective_date",
    "acquired_on",
    "loss_code",
    "detail",
    "total_remuneration_won",
    "due_date",
    "deadline_status",
  ],
};

/** Only server-verified PENDING filings may enter the local four-insurer EDI portal-upload worksheet. */
export function isEdiEligible(task: Pick<FilingTask, "state">): boolean {
  return task.state === "PENDING";
}

/**
 * Build a formula-neutralized UTF-8 BOM CSV upload worksheet from verified server `FilingTask` rows only.
 * Never fabricates RRNs, bank accounts, or unverified 4insure fixed-width record layouts.
 */
export function buildStatutoryEdiCsv(tasks: readonly FilingTask[], labels: EdiExportLabels = DEFAULT_LABELS): string {
  const eligible = tasks.filter(isEdiEligible);
  if (eligible.length === 0) {
    throw new Error("No eligible PENDING filings for EDI export");
  }
  const formatInsurer = labels.formatInsurer ?? ((v: string) => v);
  const formatKind = labels.formatKind ?? ((v: string) => v);
  const rows = eligible.map((task) => [
    formatInsurer(task.insurer),
    formatKind(task.kind),
    task.workplace_name ?? "",
    task.employee_number ?? "",
    task.name,
    task.effective_date,
    task.acquired_on ?? "",
    task.loss_code ?? "",
    task.detail ?? "",
    task.total_remuneration_won != null ? String(task.total_remuneration_won) : "",
    task.due_date ?? "",
    task.deadline_status,
  ]);
  const lines = [labels.headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
