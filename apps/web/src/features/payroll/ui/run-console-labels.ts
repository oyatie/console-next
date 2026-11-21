// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import {
  buildCompactRunStages,
  shortMonthDay,
  type PayrollLineSummary,
  type PayrollRunDetail,
} from "../domain/run-register";

export function buildRunStageSteps(run: PayrollRunDetail["run"]) {
  return buildCompactRunStages(run.status).map(step => ({
    ...step,
    label:
      step.key === "calc"
        ? t("payroll.run.CALCULATED")
        : step.key === "approval"
          ? run.status === "SUBMITTED"
            ? t("payroll.run.SUBMITTED")
            : t("payroll.run.stagePendingApproval")
          : t("payroll.run.stagePayDate", { date: shortMonthDay(run.pay_date) }),
  }));
}

export function buildRunStatusSegments({
  detailData,
  rangeFrom,
  rangeTo,
  selectedStatusLine,
  selectedStatusCount,
  selectedStatusName,
  attentionCount,
  hasBankIssues,
}: {
  detailData: PayrollRunDetail;
  rangeFrom: number;
  rangeTo: number;
  selectedStatusLine?: PayrollLineSummary;
  selectedStatusCount: number;
  selectedStatusName: string;
  attentionCount: number;
  hasBankIssues: boolean;
}) {
  return [
    { id: "target", tone: "strong" as const, content: t("payroll.run.statusTarget", { count: detailData.lines_total }) },
    ...(rangeTo > 0 ? [{ id: "shown", content: t("payroll.run.statusShown", { from: rangeFrom, to: rangeTo }) }] : []),
    ...(selectedStatusLine && selectedStatusCount > 0
      ? [
          {
            id: "selected",
            content: t("payroll.run.statusSelected", { count: selectedStatusCount, name: selectedStatusName }),
          },
          ...(selectedStatusLine.net_won != null
            ? [{ id: "selected-net", content: t("payroll.run.statusSelectedNet", { amount: fmtNumber(selectedStatusLine.net_won) }) }]
            : []),
        ]
      : []),
    ...(attentionCount > 0
      ? [
          {
            id: "attention",
            tone: "attention" as const,
            content: hasBankIssues
              ? t("payroll.run.statusBankHold", { count: attentionCount })
              : t("payroll.run.statusAttention", { count: attentionCount }),
          },
        ]
      : []),
  ];
}
