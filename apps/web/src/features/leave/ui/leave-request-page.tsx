// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Segmented } from "../../../ui/button/segmented";
import { DateField } from "../../../ui/date/date-field";
import { isDate } from "../../../ui/date/days";
import { Field } from "../../../ui/field/field";
import { StatRow } from "../../../ui/key-value/key-value";
import { FormPattern } from "../../../ui/patterns/form";
import { FormSection } from "../../../ui/patterns/form-section";
import {
  createLeaveRequest,
  leaveSubmitError,
  myLeaveQuery,
  myScheduleQuery,
} from "../api";
import {
  buildLeaveCreatePayload,
  collectLoadedSchedules,
  computeRequestedDays,
  listScheduleMonths,
  parseLeaveUnits,
  validateLeaveDates,
  type LeaveOptionKind,
  type LeaveSpanMode,
} from "../domain/leave-form";
import { buildLeaveBalanceView } from "../present";
import {
  LeaveBalanceSummary,
  LeaveHistorySection,
  LeaveStatusBanners,
} from "./leave-history-section";
import { LeaveRequestBaseline } from "./leave-request-baseline";
import s from "./leave-request-page.module.css";

/** Self-service annual / half-day leave filing page (`P7` `FormPattern` at `/leave`). */
export function LeaveRequestPage() {
  const today = todayKst();
  const q = useQuery(myLeaveQuery);
  const [kind, setKind] = useState<LeaveOptionKind>("annual");
  const [spanMode, setSpanMode] = useState<LeaveSpanMode>("one");
  const [startDate, setStartDate] = useState<string>(today);
  const [endDate, setEndDate] = useState<string>(today);
  const [startInvalid, setStartInvalid] = useState(false);
  const [endInvalid, setEndInvalid] = useState(false);
  const [receipt, setReceipt] = useState<{ kind: LeaveOptionKind; startDate: string; endDate: string; days: number } | null>(null);

  const startMonth = isDate(startDate) ? startDate.slice(0, 7) : today.slice(0, 7);
  const rangeMonths = useMemo(() => {
    if (kind !== "annual" || spanMode !== "multi" || !isDate(startDate) || !isDate(endDate) || endDate < startDate) {
      return [startMonth];
    }
    const months = listScheduleMonths(startDate, endDate);
    return months.length > 0 ? months : [startMonth];
  }, [kind, spanMode, startDate, endDate, startMonth]);

  const scheduleQueries = useQueries({
    queries: rangeMonths.map((month) => ({
      ...myScheduleQuery(month),
      retry: false,
      enabled: month === startMonth || (spanMode === "multi" && kind === "annual"),
    })),
  });

  const { scheduleByDate, loadedMonths } = collectLoadedSchedules(rangeMonths, scheduleQueries);

  const command = useCommand({
    run: (input: { kind: LeaveOptionKind; startDate: string; endDate: string; days: number }, idempotencyKey) =>
      createLeaveRequest(buildLeaveCreatePayload({ idempotencyKey, ...input })),
    invalidates: ["/api/v2/me/leave", "/api/v1/me/action-inbox"],
    settle: true,
    onSuccess: (_out, input) => {
      setReceipt(input);
    },
  });

  const handleKindChange = (next: LeaveOptionKind) => {
    setKind(next);
    setReceipt(null);
    command.reset();
    if (next !== "annual") {
      setSpanMode("one");
      setEndDate(startDate);
      setEndInvalid(false);
    }
  };

  const handleSpanModeChange = (next: LeaveSpanMode) => {
    setSpanMode(next);
    setReceipt(null);
    command.reset();
    if (next === "one") {
      setEndDate(startDate);
      setEndInvalid(false);
    } else if (kind !== "annual") {
      setKind("annual");
    }
  };

  const handleStartChange = (next: string) => {
    setStartDate(next);
    setReceipt(null);
    command.reset();
    if (spanMode === "one" || kind !== "annual" || (isDate(next) && (!isDate(endDate) || endDate < next))) {
      setEndDate(next);
      setEndInvalid(false);
    }
  };

  const handleEndChange = (next: string) => {
    setEndDate(next);
    setReceipt(null);
    command.reset();
    if (kind === "annual" && isDate(next) && isDate(startDate) && next > startDate) {
      setSpanMode("multi");
    }
  };

  const balance = q.data?.balance;
  const accrued = parseLeaveUnits(balance?.accrued_units);
  const used = parseLeaveUnits(balance?.used_units);
  const remaining = parseLeaveUnits(balance?.remaining_units);
  const filingReady = balance?.filing_state === "ready";
  const dateProblem = validateLeaveDates(startDate, endDate);
  const startError = !isDate(startDate) && !startInvalid ? t("leave.failed.invalidRange") : undefined;
  const endError =
    dateProblem === "end_before_start"
      ? t("leave.date.endBeforeStart")
      : dateProblem === "range_max"
        ? t("leave.date.rangeMax")
        : undefined;

  const requestedDays = computeRequestedDays({ kind, startDate, endDate, scheduleByDate, loadedMonths });
  const remainingAfter = remaining != null ? Math.round((remaining - requestedDays) * 100) / 100 : null;
  const canSubmit =
    Boolean(balance) &&
    filingReady &&
    !startInvalid &&
    !endInvalid &&
    isDate(startDate) &&
    isDate(endDate) &&
    dateProblem === null &&
    requestedDays > 0;

  const { balanceStatItems, legendItems, meterData, consequenceItems } = buildLeaveBalanceView({
    accrued,
    used,
    remaining,
    requestedDays,
    remainingAfter,
    kind,
  });

  const kindItems = (
    [
      { id: "annual", label: t("leave.type.annual") },
      { id: "half_am", label: t("leave.type.halfAm") },
      { id: "half_pm", label: t("leave.type.halfPm") },
    ] as const
  ).map((item) => ({ ...item, icon: kind === item.id ? <Check size={14} aria-hidden="true" /> : undefined }));

  const spanItems = (
    [
      { id: "one", label: t("leave.date.oneDay") },
      { id: "multi", label: t("leave.date.multiDay") },
    ] as const
  ).map((item) => ({ ...item, icon: spanMode === item.id ? <Check size={14} aria-hidden="true" /> : undefined }));

  const handleSubmit = () => {
    if (!canSubmit || command.isPending) return;
    setReceipt(null);
    command.mutate({ kind, startDate, endDate, days: requestedDays });
  };

  const notes = (
    <LeaveStatusBanners
      hasBalance={Boolean(balance)}
      filingReady={filingReady}
      receipt={receipt}
      onResetReceipt={() => {
        setReceipt(null);
        command.reset();
      }}
    />
  );

  const historySection = <LeaveHistorySection items={q.data?.requests.items ?? []} />;
  const submitButton = (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      block
      disabled={!canSubmit || command.isPending}
      data-pending={command.isPending || undefined}
    >
      {t("leave.submit")}
    </Button>
  );
  const submitNotice = command.error ? <CommandError error={command.error} own={leaveSubmitError} focusOnRefusal /> : null;

  return (
    <FormPattern
      q={q}
      head={{ title: t("leave.title"), titleId: "leave-request-title" }}
      notes={notes}
      summary={<LeaveBalanceSummary statItems={balanceStatItems} meter={meterData} legendItems={legendItems} />}
      sections={
        <>
          <FormSection>
            <Field label={t("leave.type.label")} required={null}>
              {() => (
                <Segmented block label={t("leave.type.label")} value={kind} onChange={handleKindChange} items={kindItems} />
              )}
            </Field>
          </FormSection>
          <FormSection>
            <div className={s.dateHead}>
              <span className="t-sm t-medium t-ink">{t("leave.date.label")}</span>
              <Segmented label={t("leave.date.modeLabel")} value={spanMode} onChange={handleSpanModeChange} items={spanItems} />
            </div>
            <div className={s.datePair}>
              <DateField
                label={t("leave.date.start")}
                required={null}
                value={startDate}
                onChange={handleStartChange}
                onInvalid={setStartInvalid}
                today={today}
                displayFormat="short-weekday"
                error={startError}
              />
              <DateField
                label={t("leave.date.end")}
                required={null}
                value={endDate}
                onChange={handleEndChange}
                onInvalid={setEndInvalid}
                today={today}
                min={startDate}
                disabled={kind !== "annual"}
                displayFormat="short-weekday"
                error={endError}
              />
            </div>
          </FormSection>
          {historySection}
        </>
      }
      notice={submitNotice}
      consequence={<StatRow items={consequenceItems} label={t("leave.summary.label")} />}
      actions={submitButton}
      onSubmit={handleSubmit}
      noValidate
      baseline={() => (
        <LeaveRequestBaseline
          q={q}
          statItems={balanceStatItems}
          meter={meterData}
          legendItems={legendItems}
          notes={notes}
          kind={kind}
          onKindChange={handleKindChange}
          kindItems={kindItems}
          spanMode={spanMode}
          onSpanModeChange={handleSpanModeChange}
          spanItems={spanItems}
          startDate={startDate}
          endDate={endDate}
          onStartChange={handleStartChange}
          onEndChange={handleEndChange}
          onStartInvalid={setStartInvalid}
          onEndInvalid={setEndInvalid}
          startError={startError}
          endError={endError}
          today={today}
          consequenceItems={consequenceItems}
          notice={submitNotice}
          actions={submitButton}
          history={historySection}
          onSubmit={handleSubmit}
        />
      )}
    />
  );
}
