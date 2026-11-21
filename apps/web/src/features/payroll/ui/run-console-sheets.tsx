// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { csvCell } from "../../../lib/csv-cell";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RegisterBlockerItem, RegisterBlockerRow, RegisterSheetStack } from "../../../ui/patterns/register-totals-parts";
import { Sheet } from "../../../ui/sheet/sheet";
import {
  buildRunCsvMatrix,
  type PayrollLineSummary,
  type PayrollRunDetail,
  type RegisterFilterMode,
} from "../domain/run-register";
import { buildRunCsvHeader, runStatus } from "../present";

export function RunPrecheckBlockers({
  attentionCount,
  hasBankIssues,
  readyCount,
  unreviewed,
  filter,
  onToggleFilter,
}: {
  attentionCount: number;
  hasBankIssues: boolean;
  readyCount: number;
  unreviewed: boolean;
  filter: RegisterFilterMode;
  onToggleFilter: () => void;
}) {
  return (
    <RegisterBlockerRow title={t("payroll.run.precheckTitle")}>
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
  runHeadcount,
  entityLabel,
  visibleLines,
  bankHoldCount,
  exportOpen,
  submitOpen,
  onCloseExport,
  onCloseSubmit,
}: {
  detail?: PayrollRunDetail;
  runHeadcount: number;
  entityLabel: string;
  visibleLines: readonly PayrollLineSummary[];
  bankHoldCount: number;
  exportOpen: boolean;
  submitOpen: boolean;
  onCloseExport: () => void;
  onCloseSubmit: () => void;
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
    <>
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
              { key: "entity", label: t("payroll.entity"), value: entityLabel },
              { key: "month", label: t("payroll.create.month"), value: detail?.run.attribution_month ?? "—" },
              { key: "rows", label: t("payroll.run.statTarget"), value: t("payroll.run.personCount", { count: visibleLines.length }) },
            ]}
          />
        </RegisterSheetStack>
      </Sheet>
      <Sheet
        open={submitOpen}
        title={t("payroll.run.submitSheetTitle")}
        onClose={onCloseSubmit}
        consequence={t("payroll.run.submitSheetConsequence")}
        actions={
          <Button variant="primary" onClick={onCloseSubmit}>
            {t("uiSheet.close")}
          </Button>
        }
      >
        <RegisterSheetStack>
          <KeyValue
            readOnly
            items={[
              { key: "status", label: t("payroll.status"), value: detail ? runStatus(detail.run.status) : "—" },
              {
                key: "target",
                label: t("payroll.run.statTarget"),
                value: detail ? t("payroll.run.personCount", { count: runHeadcount }) : "—",
              },
              {
                key: "net",
                label: t("payroll.run.statNet"),
                value:
                  detail?.calculation?.total_net_won != null
                    ? t("payroll.employee.won", { amount: fmtNumber(detail.calculation.total_net_won) })
                    : "—",
              },
              {
                key: "holds",
                label: t("payroll.run.precheckTitle"),
                value:
                  bankHoldCount > 0
                    ? t("payroll.run.missingBankChip", { count: bankHoldCount })
                    : detail?.exceptions_open
                      ? t("payroll.run.attentionChip", { count: detail.exceptions_open })
                      : t("payroll.run.bankRegistered"),
              },
            ]}
          />
        </RegisterSheetStack>
      </Sheet>
    </>
  );
}
