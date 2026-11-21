// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { StatRowItem } from "../../ui/key-value/key-value";
import type { MeterLegendItem } from "../../ui/meter/meter-legend";
import { leaveOptionLabel } from "./api";
import { formatLeaveDays, type LeaveOptionKind } from "./domain/leave-form";

/** Builds the balance summary tiles, segmented meter props, and consequence strip for `/leave`. */
export function buildLeaveBalanceView({
  accrued,
  used,
  remaining,
  requestedDays,
  remainingAfter,
  kind,
}: {
  accrued: number | null;
  used: number | null;
  remaining: number | null;
  requestedDays: number;
  remainingAfter: number | null;
  kind: LeaveOptionKind;
}) {
  const unset = t("leave.balance.unset");
  const formatDaysValue = (n: number | null) =>
    n == null ? unset : t("leave.balance.days", { days: formatLeaveDays(n) });
  const balanceStatItems: readonly StatRowItem[] = [
    { key: "accrued", label: t("leave.balance.accrued"), value: formatDaysValue(accrued) },
    { key: "used", label: t("leave.balance.used"), value: formatDaysValue(used) },
    { key: "remaining", label: t("leave.balance.remaining"), value: formatDaysValue(remaining), tone: "muted" },
  ];
  const legendItems: readonly MeterLegendItem[] = [
    { key: "used", swatch: "used", label: t("leave.meter.used", { days: used != null ? formatLeaveDays(used) : unset }) },
    { key: "pending", swatch: "pending", label: t("leave.meter.pending", { days: formatLeaveDays(requestedDays) }), strong: true },
    { key: "after", swatch: "rest", label: t("leave.meter.after", { days: remainingAfter != null ? formatLeaveDays(remainingAfter) : unset }) },
  ];
  const meterData = {
    value: used ?? 0,
    pending: requestedDays,
    max: accrued ?? 0,
    warn: remainingAfter != null && remainingAfter < 0,
    valueText: t("leave.meter.valueText", {
      accrued: accrued != null ? formatLeaveDays(accrued) : unset,
      used: used != null ? formatLeaveDays(used) : unset,
      pending: formatLeaveDays(requestedDays),
      after: remainingAfter != null ? formatLeaveDays(remainingAfter) : unset,
    }),
  };
  const consequenceItems: readonly StatRowItem[] = [
    { key: "current", label: t("leave.summary.current"), value: formatDaysValue(remaining) },
    {
      key: "requested",
      label: t("leave.summary.requested"),
      value: t("leave.summary.requestedValue", { kind: leaveOptionLabel(kind), days: formatLeaveDays(requestedDays) }),
    },
    { key: "after", label: t("leave.summary.after"), value: formatDaysValue(remainingAfter), tone: "primary" },
  ];
  return { balanceStatItems, legendItems, meterData, consequenceItems };
}
