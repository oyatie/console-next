// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button-base";
import { Chip } from "../../../ui/chip";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { FileDrop, type Accept } from "../../../ui/file-drop/file-drop";
import { StatRow } from "../../../ui/key-value/key-value";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import {
  ApiError,
  applyAttendanceImport,
  attendanceImportSummaryQuery,
  dryRunAttendanceImport,
  previewAttendanceImport,
  type AttendanceImportDryRun,
  type AttendanceImportPreview,
} from "../api";
import { AttendanceTabNav } from "./attendance-head";
import { ImportApplySection, ImportHistorySection } from "./import-console-sections";
import s from "./attendance-console.module.css";

const ACCEPT: readonly Accept[] = [
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  { mime: "text/csv", ext: ".csv" },
];
const MAX_BYTES = 16 * 1024 * 1024;
type KpiFilter = "all" | "error" | "duplicate" | "missing" | "ambiguous";

export function ImportConsoleView({ baseline }: { baseline: () => React.ReactNode }) {
  const today = todayKst();
  const summary = useQuery(attendanceImportSummaryQuery());
  const [file, setFile] = useState<File | null>(null);
  const [periodStart, setPeriodStart] = useState(`${today.slice(0, 7)}-01`);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [preview, setPreview] = useState<AttendanceImportPreview | null>(null);
  const [dryRun, setDryRun] = useState<AttendanceImportDryRun | null>(null);
  const [kpiFilter, setKpiFilter] = useState<KpiFilter>("all");
  const [ack, setAck] = useState<string[]>([]);
  const [applied, setApplied] = useState<{
    inserted: number;
    skipped: number;
    errorRows: number;
    skippedRows: AttendanceImportDryRun["row_errors"];
  } | null>(null);

  const previewCmd = useCommand({
    run: async () => {
      if (!file) throw new Error("missing_file");
      const res = await previewAttendanceImport(file, periodStart, periodEnd);
      setPreview(res);
      setDryRun(null);
      setAck([]);
      setApplied(null);
      return res;
    },
    invalidates: ["/api/v1/hr/attendance-import/summary"],
  });

  const dryRunCmd = useCommand({
    run: async () => {
      if (!preview) throw new Error("missing_preview");
      const res = await dryRunAttendanceImport(preview.run_id);
      setDryRun(res);
      setKpiFilter("all");
      return res;
    },
    invalidates: ["/api/v1/hr/attendance-import/summary"],
  });

  const applyCmd = useCommand({
    run: async () => {
      if (!preview) throw new Error("missing_preview");
      const res = await applyAttendanceImport(preview.run_id, ack.includes("ack"));
      setApplied({
        inserted: res.inserted,
        skipped: res.skipped,
        errorRows: res.error_rows ?? 0,
        skippedRows: res.skipped_rows ?? [],
      });
      return res;
    },
    invalidates: ["/api/v1/hr/attendance-import/summary", "/api/v1/attendance"],
    awaitFirstRead: true,
    announce: (res) => t("attendance.import.appliedReceipt", { inserted: res.inserted, skipped: res.skipped }),
  });

  const startUpload = () => {
    previewCmd.mutate(undefined);
  };
  const startDryRun = () => {
    dryRunCmd.mutate(undefined);
  };
  const startApply = () => {
    applyCmd.mutate(undefined);
  };

  const denied = summary.error instanceof ApiError && summary.error.status === 403;
  const filteredErrors = (dryRun?.row_errors ?? []).filter((row) => {
    if (kpiFilter === "all") return true;
    const code = row.code.toLowerCase();
    if (kpiFilter === "duplicate") return code.includes("dup");
    if (kpiFilter === "missing") return code.includes("missing") || code.includes("not_found");
    if (kpiFilter === "ambiguous") return code.includes("ambiguous");
    return true;
  });

  const canUpload = Boolean(file && /^\d{4}-\d{2}-\d{2}$/.test(periodStart) && /^\d{4}-\d{2}-\d{2}$/.test(periodEnd) && periodEnd >= periodStart);
  const uploadBlockReason = !file
    ? t("attendance.import.uploadMissingFile")
    : t("attendance.import.invalidDateRange");
  const canApply = Boolean(dryRun && dryRun.ready_rows > 0 && ack.includes("ack") && !applied);
  const applyBlockReason = applied
    ? t("attendance.import.appliedReceipt", { inserted: applied.inserted, skipped: applied.skipped })
    : !dryRun
      ? t("attendance.import.step.dryRun")
      : dryRun.ready_rows === 0
        ? t("attendance.import.blockedErrors")
        : !ack.includes("ack")
          ? t("attendance.import.blockedAck")
          : null;

  const commandError = previewCmd.error ?? dryRunCmd.error ?? applyCmd.error;

  return (
    <ListRecord
      q={summary}
      tabs={<AttendanceTabNav tab="import" />}
      head={{
        title: t("attendance.import.title"),
        titleId: "attendance-import-title",
      }}
      notes={
        applied ? (
          <Receipt state="recorded" message={t("attendance.import.appliedReceipt", { inserted: applied.inserted, skipped: applied.skipped })} />
        ) : commandError ? (
          <CommandError error={commandError} />
        ) : undefined
      }
      stats={
        dryRun ? (
          <StatRow
            label={t("attendance.import.step.dryRun")}
            items={[
              { key: "all", label: t("attendance.import.kpi.all"), value: dryRun.input_rows, active: kpiFilter === "all", onPress: () => setKpiFilter("all") },
              { key: "ready", label: t("attendance.import.kpi.ready"), value: dryRun.ready_rows, tone: "ok" },
              { key: "errors", label: t("attendance.import.kpi.errors"), value: dryRun.error_rows, tone: dryRun.error_rows > 0 ? "danger" : undefined, active: kpiFilter === "error", onPress: () => setKpiFilter("error") },
              { key: "duplicates", label: t("attendance.import.kpi.duplicates"), value: dryRun.duplicate_rows, tone: dryRun.duplicate_rows > 0 ? "warn" : undefined, active: kpiFilter === "duplicate", onPress: () => setKpiFilter("duplicate") },
              { key: "missing", label: t("attendance.import.kpi.missing"), value: dryRun.missing_employee_rows, tone: dryRun.missing_employee_rows > 0 ? "warn" : undefined, active: kpiFilter === "missing", onPress: () => setKpiFilter("missing") },
              { key: "ambiguous", label: t("attendance.import.kpi.ambiguous"), value: dryRun.ambiguous_employee_rows, tone: dryRun.ambiguous_employee_rows > 0 ? "warn" : undefined, active: kpiFilter === "ambiguous", onPress: () => setKpiFilter("ambiguous") },
            ]}
          />
        ) : undefined
      }
      list={
        denied ? (
          <EmptyState alert title={t("attendance.import.denied")} reason={t("attendance.import.denied")} />
        ) : (
          <div className={s.paneBody}>
            <RecordPaneSection title={t("attendance.import.step.upload")}>
              <div className={s.paneBody}>
                <FileDrop
                  label={t("attendance.import.fileLabel")}
                  accept={ACCEPT}
                  maxBytes={MAX_BYTES}
                  onFiles={(files) => setFile(files[0] ?? null)}
                >
                  {file ? <span className="muted">{file.name}</span> : undefined}
                </FileDrop>
                <div className={s.filterPair}>
                  <DateField
                    label={t("attendance.import.periodStart")}
                    required
                    today={today}
                    value={periodStart}
                    onChange={setPeriodStart}
                  />
                  <DateField
                    label={t("attendance.import.periodEnd")}
                    required
                    today={today}
                    value={periodEnd}
                    onChange={setPeriodEnd}
                  />
                </div>
                <div className={s.paneActions}>
                  {canUpload ? (
                    <Button
                      size="sm"
                      variant="primary"
                      className={s.nowrap}
                      disabled={previewCmd.isPending}
                      onClick={startUpload}
                    >
                      {t("attendance.import.uploadAction")}
                    </Button>
                  ) : (
                    <DisabledReason
                      layout="inline"
                      reason={uploadBlockReason}
                      control={(props) => (
                        <Button {...props} size="sm" variant="primary" className={s.nowrap}>
                          {t("attendance.import.uploadAction")}
                        </Button>
                      )}
                    />
                  )}
                </div>
              </div>
            </RecordPaneSection>

            {preview && (
              <RecordPaneSection title={t("attendance.import.step.preview")}>
                <div className={s.paneBody}>
                  <div className={s.paneActions}>
                    {preview.columns.map((col, idx) => {
                      const badgeLabel = t("shellRoutes.pair", {
                        primary: col.source_header,
                        secondary: t(`attendance.import.${col.classification}Badge`),
                      });
                      return (
                        <Chip
                          key={`${col.source_header}-${idx}`}
                          tone={col.classification === "restricted" ? "warn" : col.classification === "canonical" ? "ok" : "neutral"}
                        >
                          {badgeLabel}
                        </Chip>
                      );
                    })}
                  </div>
                  <div className={s.paneActions}>
                    <Button
                      size="sm"
                      variant="primary"
                      className={s.nowrap}
                      disabled={dryRunCmd.isPending}
                      onClick={startDryRun}
                    >
                      {t("attendance.import.dryRunAction")}
                    </Button>
                  </div>
                </div>
              </RecordPaneSection>
            )}

            {dryRun && (
              <ImportApplySection
                readyRows={dryRun.ready_rows}
                errorRows={dryRun.error_rows}
                allErrors={applied?.skippedRows.length ? applied.skippedRows : dryRun.row_errors}
                filteredErrors={filteredErrors}
                ack={ack}
                onAckChange={setAck}
                canApply={canApply}
                applyBlockReason={applyBlockReason}
                pending={applyCmd.isPending}
                onApply={startApply}
              />
            )}

            <ImportHistorySection items={summary.data?.items ?? []} />
          </div>
        )
      }
      baseline={baseline}
    />
  );
}
