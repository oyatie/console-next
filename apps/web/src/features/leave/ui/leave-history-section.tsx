// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateShortWeekday } from "@console/i18n/format";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { StatRow, type StatRowItem } from "../../../ui/key-value/key-value";
import { Meter } from "../../../ui/meter/meter";
import { MeterBand, MeterLegend, type MeterLegendItem } from "../../../ui/meter/meter-legend";
import { FormRow, FormRowList, FormSection } from "../../../ui/patterns/form-section";
import { leaveOptionLabel, type LeaveRequestView } from "../api";
import { formatLeaveDays, type LeaveOptionKind } from "../domain/leave-form";
import s from "./leave-request-page.module.css";

function requestKindLabel(request: LeaveRequestView): string {
  if (request.leave_type === "half_day") {
    return request.partial_day_period === "pm" ? t("leave.type.halfPm") : t("leave.type.halfAm");
  }
  return t("leave.type.annual");
}

function requestStatusMeta(status: LeaveRequestView["status"]): { label: string; tone: ComponentProps<typeof Chip>["tone"] } {
  switch (status) {
    case "approved":
      return { label: t("leave.status.approved"), tone: "ok" };
    case "rejected":
    case "returned":
      return { label: t("leave.status.rejected"), tone: "danger" };
    case "time_change_consult":
      return { label: t("leave.status.consult"), tone: "warn" };
    default:
      return { label: t("leave.status.pending"), tone: "info" };
  }
}

export function LeaveBalanceSummary({
  statItems,
  meter,
  legendItems,
}: {
  statItems: readonly StatRowItem[];
  meter: { value: number; pending: number; max: number; warn: boolean; valueText: string };
  legendItems: readonly MeterLegendItem[];
}) {
  return (
    <>
      <StatRow items={statItems} label={t("leave.balance.label")} />
      <MeterBand>
        <Meter
          value={meter.value}
          pending={meter.pending}
          max={meter.max}
          cells={30}
          warn={meter.warn}
          label={t("leave.meter.label")}
          valueText={meter.valueText}
        />
        <MeterLegend items={legendItems} />
      </MeterBand>
    </>
  );
}

export function LeaveStatusBanners({
  hasBalance,
  filingReady,
  receipt,
  onResetReceipt,
}: {
  hasBalance: boolean;
  filingReady: boolean;
  receipt: { kind: LeaveOptionKind; startDate: string; endDate: string; days: number } | null;
  onResetReceipt: () => void;
}) {
  return (
    <>
      {hasBalance && !filingReady ? (
        <Banner tone="warn" title={t("leave.filing.homeBranchRequired.title")}>
          {t("leave.filing.homeBranchRequired.reason")}
        </Banner>
      ) : null}
      {receipt ? (
        <Banner
          tone="ok"
          live="polite"
          title={t("leave.receipt.title")}
          actions={
            <Button size="sm" onClick={onResetReceipt}>
              {t("leave.receipt.another")}
            </Button>
          }
        >
          {t("leave.receipt.summary", {
            kind: leaveOptionLabel(receipt.kind),
            period:
              receipt.startDate === receipt.endDate
                ? fmtDate(receipt.startDate, { weekday: "short" })
                : t("leave.history.period", {
                    start: fmtDate(receipt.startDate, { weekday: "short" }),
                    end: fmtDate(receipt.endDate, { weekday: "short" }),
                  }),
            days: formatLeaveDays(receipt.days),
          })}
        </Banner>
      ) : null}
    </>
  );
}

export function LeaveHistorySection({ items }: { items: readonly LeaveRequestView[] }) {
  if (items.length === 0) return null;
  return (
    <FormSection>
      <div className={s.historyHead}>
        <span className="t-sm t-medium t-ink">{t("leave.history.title")}</span>
      </div>
      <FormRowList label={t("leave.history.title")}>
        {items.slice(0, 5).map((item) => {
          const meta = requestStatusMeta(item.status);
          const period =
            item.start_date === item.end_date
              ? fmtDateShortWeekday(item.start_date)
              : t("leave.history.period", {
                  start: fmtDateShortWeekday(item.start_date),
                  end: fmtDateShortWeekday(item.end_date),
                });
          const daysLabel = t("leave.balance.days", { days: formatLeaveDays(item.days) });
          return (
            <FormRow
              key={item.id}
              primary={`${requestKindLabel(item)} · ${daysLabel}`}
              end={<Chip tone={meta.tone}>{meta.label}</Chip>}
              secondary={period}
            />
          );
        })}
      </FormRowList>
    </FormSection>
  );
}
