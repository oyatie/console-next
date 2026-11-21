// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { AlertTriangle, Check as CheckIcon } from "lucide-react";
import { Check } from "../../../ui/button/button";
import { RegisterBankStatus, RegisterNowrap, RegisterPhoneOnly } from "../../../ui/patterns/register-totals-parts";
import { GroupedTable, type Column } from "../../../ui/table-grouped";
import {
  computePageSubtotals,
  deductionAmount,
  hasBankBlocker,
  type PayrollLineSummary,
} from "../domain/run-register";

const formatNumOrDash = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? fmtNumber(value) : "—";

/** 18-column grouped Console payroll register table with pinned `tfoot` subtotals and compact 390px rows. */
export function RunRegisterTable({
  lines,
  linesTotal,
  selectedId,
  onSelect,
  checkedIds,
  onToggleRow,
  onToggleAll,
}: {
  lines: readonly PayrollLineSummary[];
  linesTotal: number;
  selectedId?: string;
  onSelect: (id: string) => void;
  checkedIds: ReadonlySet<string>;
  onToggleRow: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const allVisibleChecked = lines.length > 0 && lines.every(line => checkedIds.has(line.id));
  const subtotals = computePageSubtotals(lines);

  const columns: Column<PayrollLineSummary>[] = [
    {
      header: <Check checked={allVisibleChecked} onChange={onToggleAll} aria-label={t("payroll.run.selectAll")} />,
      fit: true,
      card: "omit",
      cell: line => (
        <Check
          checked={checkedIds.has(line.id)}
          onChange={on => onToggleRow(line.id, on)}
          aria-label={t("payroll.run.selectRow", { name: line.employee_display_name })}
        />
      ),
    },
    { header: t("payroll.run.col.name"), card: "fact", cell: line => <RegisterNowrap>{line.employee_display_name}</RegisterNowrap> },
    { header: t("payroll.run.col.empNo"), type: "code", card: "omit", cell: line => line.employee_number || "—" },
    {
      header: t("payroll.run.col.unit"),
      card: "title",
      cell: line => (
        <>
          <bdi>{line.org_unit || line.employee_company || "—"}</bdi>
          <RegisterPhoneOnly>
            {t("payroll.run.phoneSummary", {
              gross: formatNumOrDash(line.gross_won),
              deductions: formatNumOrDash(line.total_deductions_won),
            })}
          </RegisterPhoneOnly>
        </>
      ),
    },
    { header: t("payroll.run.col.grade"), card: "omit", cell: line => line.position || "—" },
    { header: t("payroll.run.col.basePay"), type: "money", card: "omit", cell: line => formatNumOrDash(line.base_pay_won) },
    { header: t("payroll.run.col.overtimePay"), type: "money", card: "omit", cell: line => formatNumOrDash(line.overtime_pay_won) },
    { header: t("payroll.run.col.mealAllowance"), type: "money", card: "omit", cell: line => formatNumOrDash(line.meal_allowance_won) },
    { header: t("payroll.run.col.grossTotal"), type: "money", emphasis: "strong", card: "omit", cell: line => formatNumOrDash(line.gross_won) },
    { header: t("enum.insurer.NPS"), type: "money", card: "omit", cell: line => formatNumOrDash(deductionAmount(line, "NATIONAL_PENSION")) },
    { header: t("enum.insurer.NHIS"), type: "money", card: "omit", cell: line => formatNumOrDash(deductionAmount(line, "HEALTH_INSURANCE")) },
    { header: t("payroll.run.col.longTermCare"), type: "money", card: "omit", cell: line => formatNumOrDash(deductionAmount(line, "LONG_TERM_CARE")) },
    { header: t("enum.insurer.EI"), type: "money", card: "omit", cell: line => formatNumOrDash(deductionAmount(line, "EMPLOYMENT_INSURANCE")) },
    { header: t("payroll.run.col.incomeTax"), type: "money", card: "omit", cell: line => formatNumOrDash(deductionAmount(line, "INCOME_TAX")) },
    { header: t("payroll.run.col.localIncomeTax"), type: "money", card: "omit", cell: line => formatNumOrDash(deductionAmount(line, "LOCAL_INCOME_TAX")) },
    { header: t("payroll.run.col.deductionsTotal"), type: "money", emphasis: "strong", card: "omit", cell: line => formatNumOrDash(line.total_deductions_won) },
    { header: t("payroll.run.col.netPay"), type: "money", emphasis: "strong", card: "action", cell: line => formatNumOrDash(line.net_won) },
    {
      header: t("payroll.run.col.bank"),
      fit: true,
      card: "status",
      cellTone: line => (hasBankBlocker(line) ? "danger" : line.blockers.length > 0 || line.calculation_status === "BLOCKED_LEGAL_GATE" ? "warn" : undefined),
      cell: line =>
        hasBankBlocker(line) ? (
          <RegisterBankStatus icon={<AlertTriangle size={12} aria-hidden="true" />} label={t("payroll.run.bankMissingHold")} />
        ) : line.blockers.length > 0 || line.calculation_status === "BLOCKED_LEGAL_GATE" ? (
          <RegisterBankStatus icon={<AlertTriangle size={12} aria-hidden="true" />} label={t("payroll.run.bankCheck")} />
        ) : (
          <RegisterBankStatus icon={<CheckIcon size={12} aria-hidden="true" />} label={t("payroll.run.bankRegistered")} />
        ),
    },
  ];

  return (
    <GroupedTable
      label={t("payroll.run.registerLabel")}
      density="compact"
      mobileLayout="compact"
      scrollLayout="auto"
      rows={[...lines]}
      rowId={line => line.id}
      selected={selectedId}
      onSelect={onSelect}
      columnGroups={[
        { key: "identity", span: 5 },
        { key: "earnings", label: t("payroll.run.colGroup.earnings"), span: 4 },
        { key: "deductions", label: t("payroll.run.colGroup.deductions"), span: 7 },
        { key: "settlement", span: 2 },
      ]}
      columns={columns}
      footerRow={{
        key: "subtotal",
        cells: [
          { key: "label", span: 5, content: t("payroll.run.pageSubtotal", { count: lines.length }), card: "label" },
          { key: "base", type: "money", content: formatNumOrDash(subtotals.basePayWon), card: "omit" },
          { key: "overtime", type: "money", content: formatNumOrDash(subtotals.overtimePayWon), card: "omit" },
          { key: "meal", type: "money", content: formatNumOrDash(subtotals.mealAllowanceWon), card: "omit" },
          { key: "gross", type: "money", emphasis: "strong", content: formatNumOrDash(subtotals.grossWon), card: "omit" },
          { key: "nps", type: "money", content: formatNumOrDash(subtotals.deductions.NATIONAL_PENSION), card: "omit" },
          { key: "nhis", type: "money", content: formatNumOrDash(subtotals.deductions.HEALTH_INSURANCE), card: "omit" },
          { key: "ltc", type: "money", content: formatNumOrDash(subtotals.deductions.LONG_TERM_CARE), card: "omit" },
          { key: "ei", type: "money", content: formatNumOrDash(subtotals.deductions.EMPLOYMENT_INSURANCE), card: "omit" },
          { key: "tax", type: "money", content: formatNumOrDash(subtotals.deductions.INCOME_TAX), card: "omit" },
          { key: "localTax", type: "money", content: formatNumOrDash(subtotals.deductions.LOCAL_INCOME_TAX), card: "omit" },
          { key: "dedTotal", type: "money", emphasis: "strong", content: formatNumOrDash(subtotals.totalDeductionsWon), card: "omit" },
          { key: "net", type: "money", emphasis: "strong", content: formatNumOrDash(subtotals.netWon), card: "value" },
          { key: "count", content: t("payroll.run.shownOfTotal", { shown: lines.length, total: linesTotal }), card: "meta" },
        ],
      }}
    />
  );
}
