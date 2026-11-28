// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { csvCell } from "../../../lib/csv-cell";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RegisterBlockerItem, RegisterBlockerRow, RegisterSheetStack } from "../../../ui/patterns/register-totals-parts";
import { Sheet } from "../../../ui/sheet/sheet";
import { RunAttendanceBlocker } from "./run-attendance-blocker";
import { RunOpenExceptionsBlocker } from "./run-open-exceptions-blocker";
import {
  buildRunCsvMatrix,
  type PayrollLineSummary,
  type PayrollRunDetail,
  type RegisterFilterMode,
} from "../domain/run-register";
import { buildRunCsvHeader } from "../present";

export function RunPrecheckBlockers({
  attendanceOpenWarning,
  runStatus,
  attentionCount,
  hasBankIssues,
  readyCount,
  exceptionsOpen,
  unreviewed,
  filter,
  onToggleFilter,
  onInspectExceptions,
}: {
  attendanceOpenWarning?: boolean;
  runStatus?: string;
  attentionCount: number;
  hasBankIssues: boolean;
  readyCount: number;
  exceptionsOpen: number;
  unreviewed: boolean;
  filter: RegisterFilterMode;
  onToggleFilter: () => void;
  onInspectExceptions?: () => void;
}) {
  return (
    <RegisterBlockerRow title={t("payroll.run.precheckTitle")}>
      {attendanceOpenWarning && <RunAttendanceBlocker runStatus={runStatus} />}
      {attentionCount > 0 && (
        <RegisterBlockerItem
          badge={<Chip tone="danger">{hasBankIssues ? t("payroll.run.missingBankChip", { count: attentionCount }) : t("payroll.run.attentionChip", { count: attentionCount })}</Chip>}
          note={hasBankIssues ? t("payroll.run.missingBankNote", { missing: attentionCount, ready: readyCount }) : t("payroll.run.attentionNote")}
          action={
            <Button size="sm" onClick={onToggleFilter}>
              {filter === "attention" ? t("payroll.run.showAll") : t("payroll.run.viewCount", { count: attentionCount })}
            </Button>
          }
        />
      )}
      {exceptionsOpen > 0 && onInspectExceptions && (
        <RunOpenExceptionsBlocker
          exceptionsOpen={exceptionsOpen}
          onInspectExceptions={onInspectExceptions}
        />
      )}
      {unreviewed && (
        <RegisterBlockerItem
          badge={<Chip tone="warn">{t("payroll.run.unreviewedBadge")}</Chip>}
          subject={t("payroll.run.unreviewedSubject")}
          note={t("payroll.run.unreviewedNote")}
        />
      )}
    </RegisterBlockerRow>
  );
}

export function RunActionSheets({
  detail,
  entityLabel,
  groupLabel,
  visibleLines,
  exportOpen,
  onCloseExport,
}: {
  detail?: PayrollRunDetail;
  entityLabel: string;
  groupLabel?: string;
  visibleLines: readonly PayrollLineSummary[];
  exportOpen: boolean;
  onCloseExport: () => void;
}) {
  const downloadCsv = () => {
    const header = buildRunCsvHeader();
    const rows = [header, ...buildRunCsvMatrix(visibleLines)].map(row => row.map(csvCell).join(","));
    const blob = new Blob([`\uFEFF${rows.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `payroll-${detail?.run.attribution_month ?? "run"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    onCloseExport();
  };

  return (
    <Sheet
      open={exportOpen}
      title={t("payroll.run.exportSheetTitle")}
      onClose={onCloseExport}
      consequence={t("payroll.run.exportSheetConsequence", { count: visibleLines.length })}
      actions={
        <>
          <Button onClick={onCloseExport}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={downloadCsv}>
            {t("payroll.run.exportDownload")}
          </Button>
        </>
      }
    >
      <RegisterSheetStack>
        <KeyValue
          readOnly
          items={[
            { key: "group", label: t("payroll.group"), value: groupLabel ?? entityLabel },
            { key: "entity", label: t("payroll.entity"), value: entityLabel },
            { key: "month", label: t("payroll.create.month"), value: detail?.run.attribution_month ?? "—" },
            { key: "rows", label: t("payroll.run.statTarget"), value: t("payroll.run.personCount", { count: visibleLines.length }) },
          ]}
        />
      </RegisterSheetStack>
    </Sheet>
  );
}
