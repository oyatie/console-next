// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { downloadCsv } from "../../../lib/csv-download";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button-base";
import { Chip } from "../../../ui/chip";
import { Checks } from "../../../ui/choice/checks";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { Table } from "../../../ui/table";
import type { AttendanceImportDryRun, AttendanceImportSummaryItem } from "../api";
import s from "./attendance-console.module.css";

type RowError = AttendanceImportDryRun["row_errors"][number];

export function ImportApplySection({
  readyRows,
  errorRows,
  allErrors,
  filteredErrors,
  ack,
  onAckChange,
  canApply,
  applyBlockReason,
  pending,
  onApply,
}: {
  readyRows: number;
  errorRows: number;
  allErrors: RowError[];
  filteredErrors: RowError[];
  ack: string[];
  onAckChange: (next: string[]) => void;
  canApply: boolean;
  applyBlockReason: string | null;
  pending: boolean;
  onApply: () => void;
}) {
  const applyLabel =
    errorRows > 0 && readyRows > 0
      ? t("attendance.import.applyPartialAction", { ready: readyRows, errors: errorRows })
      : t("attendance.import.applyAction");
  const downloadErrors = () =>
    downloadCsv(
      "attendance-import-skipped.csv",
      ["sheet", "row", "source_key", "code", "message"],
      allErrors.map((r) => [r.source_sheet, r.source_row, r.source_key, r.code, r.message]),
    );
  return (
    <RecordPaneSection title={t("attendance.import.step.apply")}>
      <div className={s.paneBody}>
        {filteredErrors.length > 0 && (
          <Table
            label={t("attendance.import.step.dryRun")}
            rows={filteredErrors}
            rowId={row => `${row.source_sheet}-${row.source_row}-${row.source_key}-${row.code}`}
            density="compact"
            mobileLayout="compact"
            columns={[
              { header: t("attendance.import.kpi.errors"), card: "title", cell: row => `${row.source_sheet} #${row.source_row}` },
              { header: t("attendance.col.kind"), card: "status", cell: row => <Chip tone="danger">{row.code}</Chip> },
              { header: t("attendance.issues.detail"), card: "fact", cell: row => row.message },
            ]}
          />
        )}
        <Checks
          label={t("attendance.import.step.apply")}
          items={[{ id: "ack", label: t("attendance.import.checklistAck") }]}
          value={ack}
          onChange={onAckChange}
        />
        <div className={s.paneActions}>
          {canApply ? (
            <Button size="sm" variant="primary" className={s.nowrap} disabled={pending} onClick={onApply}>
              {applyLabel}
            </Button>
          ) : (
            <DisabledReason
              reason={applyBlockReason ?? t("attendance.import.blockedErrors")}
              control={props => (
                <Button {...props} size="sm" variant="primary" className={s.nowrap}>
                  {applyLabel}
                </Button>
              )}
            />
          )}
          {allErrors.length > 0 && (
            <Button size="sm" variant="secondary" className={s.nowrap} onClick={downloadErrors}>
              {t("attendance.import.downloadSkippedCsv", { count: allErrors.length })}
            </Button>
          )}
        </div>
      </div>
    </RecordPaneSection>
  );
}

export function ImportHistorySection({ items }: { items: AttendanceImportSummaryItem[] }) {
  return (
    <RecordPaneSection title={t("attendance.import.historyTitle")} padded={items.length === 0}>
      {items.length === 0 ? (
        <Banner tone="info">{t("attendance.import.historyEmpty")}</Banner>
      ) : (
        <Table<AttendanceImportSummaryItem>
          label={t("attendance.import.historyTitle")}
          rows={items}
          rowId={item => item.run_id}
          density="compact"
          mobileLayout="compact"
          columns={[
            { header: t("attendance.import.fileLabel"), card: "title", cell: item => item.source_filename },
            {
              header: t("attendance.col.state"),
              card: "status",
              cell: item => (
                <Chip tone={item.status === "APPLIED" ? "ok" : item.status === "FAILED" ? "danger" : "info"}>
                  {t(`attendance.import.status.${item.status}`)}
                </Chip>
              ),
            },
            { header: t("attendance.import.kpi.all"), card: "omit", cell: item => fmtNumber(item.input_rows) },
            { header: t("attendance.import.historyAt"), card: "fact", cell: item => fmtDateTime(item.applied_at ?? item.created_at) },
          ]}
        />
      )}
    </RecordPaneSection>
  );
}
