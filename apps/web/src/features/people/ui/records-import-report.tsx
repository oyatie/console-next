// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Checks } from "../../../ui/choice/checks";
import { StatRow } from "../../../ui/key-value/key-value";
import { WorklistPadded } from "../../../ui/patterns/worklist-parts";
import { Table } from "../../../ui/table";
import type { RecordImportReport } from "../api/record-import";
import type { ParsedSheetRow } from "../domain/records-import-parse";

export function RecordsImportReportCard({
  step,
  report,
  parsedRows,
  mismatchAck,
  onMismatchAck,
}: {
  step: "preview" | "done";
  report: RecordImportReport;
  parsedRows: readonly ParsedSheetRow[];
  mismatchAck: string[];
  onMismatchAck: (next: string[]) => void;
}) {
  const rowsByNumber = new Map(parsedRows.map((r) => [r.row, r]));
  const createCount = report.rows.filter((r) => r.outcome === "CREATE").length;
  const updateCount = report.rows.filter((r) => r.outcome === "UPDATE").length;
  const voidCount = report.rows.filter((r) => r.outcome === "VOID").length;
  const unchangedCount = report.rows.filter((r) => r.outcome === "UNCHANGED").length;
  const errorCount = report.rows.filter((r) => r.outcome === "ERROR").length;
  const mismatchCount = report.rows.filter((r) => r.name_mismatch).length;

  return (
    <Card titleId="records-import-report" title={t(`empRec.import.step.${step}`)}>
      <StatRow
        label={t("empRec.import.step.preview")}
        items={[
          { key: "create", label: t("empRec.history.kind.CREATE"), value: fmtNumber(createCount), tone: "ok" },
          { key: "update", label: t("empRec.history.kind.UPDATE"), value: fmtNumber(updateCount), tone: "ok" },
          { key: "void", label: t("empRec.history.kind.VOID"), value: fmtNumber(voidCount) },
          { key: "unchanged", label: t("empRec.import.unchanged"), value: fmtNumber(unchangedCount) },
          { key: "error", label: t("attendance.import.kpi.errors"), value: fmtNumber(errorCount), tone: errorCount > 0 ? "danger" : undefined },
          { key: "mismatch", label: t("empRec.import.mismatchCount"), value: fmtNumber(mismatchCount), tone: mismatchCount > 0 ? "warn" : undefined },
        ]}
      />
      <Table
        label={t("empRec.import.step.preview")}
        rows={report.rows}
        rowId={(r) => String(r.row)}
        density="compact"
        mobileLayout="compact"
        columns={[
          { header: "#", card: "title", cell: (r) => fmtNumber(r.row) },
          { header: t("empRec.import.colNumber"), card: "fact", cell: (r) => rowsByNumber.get(r.row)?.employee_number ?? "—" },
          {
            header: t("empRec.import.colName"),
            card: "fact",
            cell: (r) => {
              const sheetName = rowsByNumber.get(r.row)?.employee_name;
              if (r.name_mismatch) {
                return (
                  <Chip tone="warn">
                    {t("empRec.import.mismatchCell", {
                      sheet: sheetName ?? "—",
                      stored: r.stored_name ?? "—",
                    })}
                  </Chip>
                );
              }
              return sheetName ?? r.stored_name ?? "—";
            },
          },
          {
            header: t("empRec.history.kind"),
            card: "status",
            cell: (r) => (
              <Chip tone={r.outcome === "ERROR" ? "danger" : r.outcome === "UNCHANGED" ? "neutral" : "ok"}>
                {r.outcome}
              </Chip>
            ),
          },
          { header: t("empRec.history.why"), card: "fact", cell: (r) => r.code ?? r.message ?? "—" },
        ]}
      />
      {step === "preview" && mismatchCount > 0 && (
        <WorklistPadded>
          <Checks
            label={t("empRec.import.mismatchCount")}
            items={[{ id: "mismatch", label: t("empRec.import.mismatchAck", { count: mismatchCount }) }]}
            value={mismatchAck}
            onChange={onMismatchAck}
          />
        </WorklistPadded>
      )}
    </Card>
  );
}
