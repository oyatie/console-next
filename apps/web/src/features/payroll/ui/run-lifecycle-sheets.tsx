// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Banner } from "../../../ui/banner/banner";
import { Chip } from "../../../ui/chip";
import { Checks } from "../../../ui/choice/checks";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Composer } from "../../../ui/composer/composer";
import { DateField } from "../../../ui/date/date-field";
import { Field } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { TextArea } from "../../../ui/field/text-area";
import {
  attestPayrollDisbursement,
  calculatePayrollRun,
  closePayrollAttendance,
  decidePayrollRun,
  issuePayrollPayslips,
  payrollClosePreflightQuery,
  schedulePayrollDisbursement,
  submitPayrollRun,
  withdrawPayrollRun,
} from "../api";
import { payrollErrorMessageKey, type RunLifecycleSheetKind } from "../domain/run-lifecycle";
import type { PayrollRunDetail } from "../domain/run-register";
import { runStatus } from "../present";

const ownError = (code: string) => {
  const key = payrollErrorMessageKey(code);
  return key && isMessageId(key) ? t(key) : undefined;
};

type DisbursementStatus = "SCHEDULED" | "SUBMITTED_TO_BANK" | "PAID" | "FAILED";

export function RunLifecycleSheet({
  kind,
  detail,
  runHeadcount,
  bankHoldCount,
  onClose,
}: {
  kind: RunLifecycleSheetKind;
  detail: PayrollRunDetail;
  runHeadcount: number;
  bankHoldCount: number;
  onClose: () => void;
}) {
  const today = todayKst();
  const [attest, setAttest] = useState<string[]>([]);
  const [decision, setDecision] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [decisionReason, setDecisionReason] = useState("");
  const [scheduledDate, setScheduledDate] = useState(detail.run.pay_date ?? today);
  const [disbursementStatus, setDisbursementStatus] = useState<DisbursementStatus>("PAID");
  const [disbursementReason, setDisbursementReason] = useState("");

  const preflight = useQuery({
    ...payrollClosePreflightQuery(detail.run.id),
    enabled: kind === "closeAttendance",
  });

  const cmd = useCommand({
    run: async () => {
      switch (kind) {
        case "closeAttendance":
          return closePayrollAttendance(detail.run.id);
        case "calculate":
          return calculatePayrollRun(detail.run.id);
        case "submit":
          return submitPayrollRun(detail.run.id);
        case "decide":
          return decidePayrollRun(detail.run.id, {
            decision,
            ...(decisionReason.trim() ? { reason: decisionReason.trim() } : {}),
          });
        case "withdraw":
          return withdrawPayrollRun(detail.run.id);
        case "scheduleDisbursement":
          return schedulePayrollDisbursement(detail.run.id, `${scheduledDate}T09:00:00+09:00`);
        case "attestDisbursement":
          return attestPayrollDisbursement(detail.run.id, {
            status: disbursementStatus,
            ...(disbursementReason.trim() ? { reason: disbursementReason.trim() } : {}),
          });
        case "issuePayslips":
          return issuePayrollPayslips(detail.run.id);
      }
    },
    invalidates: ["/api/v1/payroll"],
    awaitFirstRead: true,
    announce: () => {
      switch (kind) {
        case "closeAttendance":
          return t("payrollRun.closeAttendance.done");
        case "calculate":
          return t("payrollRun.calculate.done");
        case "submit":
          return t("payrollRun.submit.done");
        case "decide":
          return t("payrollRun.decision.done");
        case "withdraw":
          return t("payrollRun.withdraw.done");
        case "scheduleDisbursement":
          return t("payrollRun.disbursement.scheduleDone");
        case "attestDisbursement":
          return t("payrollRun.disbursement.attestDone");
        case "issuePayslips":
          return t("payrollRun.issuePayslips.done");
      }
    },
    onSuccess: () => onClose(),
  });

  const title = (() => {
    switch (kind) {
      case "closeAttendance":
        return t("payrollRun.cta.closeAttendance");
      case "calculate":
        return t("payrollRun.cta.calculate");
      case "submit":
        return t("payroll.run.submitSheetTitle");
      case "decide":
        return t("payrollRun.cta.decide");
      case "withdraw":
        return t("payrollRun.cta.withdraw");
      case "scheduleDisbursement":
        return t("payrollRun.cta.scheduleDisbursement");
      case "attestDisbursement":
        return t("payrollRun.cta.attestDisbursement");
      case "issuePayslips":
        return t("payrollRun.cta.issuePayslips");
    }
  })();

  const actionMode = (() => {
    switch (kind) {
      case "calculate":
        return "calculate" as const;
      case "submit":
        return "request" as const;
      case "decide":
        return decision === "APPROVE" ? ("approve" as const) : ("reject" as const);
      case "withdraw":
        return "withdraw" as const;
      case "scheduleDisbursement":
        return "schedule" as const;
      case "issuePayslips":
        return "issue" as const;
      default:
        return "complete" as const;
    }
  })();

  const blockedReason = (() => {
    if (kind === "closeAttendance") {
      if (preflight.data && !preflight.data.can_close) return t("payrollRun.error.preflight_blocked");
      if (!attest.includes("attest")) return t("payrollRun.closeAttendance.attest");
    }
    if (kind === "submit" && detail.exceptions_open > 0) {
      return t("payrollRun.blocked.exceptionsOpen", { count: detail.exceptions_open });
    }
    if (kind === "decide" && decision === "REJECT" && !decisionReason.trim()) {
      return t("payrollRun.decision.rejectRequiresReason");
    }
    if (kind === "scheduleDisbursement" && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
      return t("payrollRun.disbursement.scheduledAt");
    }
    if (kind === "attestDisbursement" && disbursementStatus === "FAILED" && !disbursementReason.trim()) {
      return t("payrollRun.disbursement.failedRequiresReason");
    }
    return null;
  })();

  return (
    <Composer
      open
      title={title}
      subtitle={`${detail.run.attribution_month ?? ""} · ${runStatus(detail.run.status)}`}
      action={{ kind: "payrollRun", mode: actionMode }}
      tone={kind === "decide" && decision === "REJECT" ? "danger" : "primary"}
      onClose={onClose}
      pending={cmd.isPending}
      loading={kind === "closeAttendance" && preflight.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} own={ownError} />}
      consequence={kind === "submit" ? t("payroll.run.submitSheetConsequence") : undefined}
      dirty={attest.length > 0 || Boolean(decisionReason || disbursementReason)}
      blocked={blockedReason ? { reason: blockedReason } : undefined}
      onSubmit={() => {
        cmd.mutate(undefined);
      }}
    >
      <KeyValue
        readOnly
        items={[
          { key: "status", label: t("payroll.status"), value: runStatus(detail.run.status) },
          { key: "target", label: t("payroll.run.statTarget"), value: t("payroll.run.personCount", { count: runHeadcount }) },
          {
            key: "net",
            label: t("payroll.run.statNet"),
            value:
              detail.calculation?.total_net_won != null
                ? t("payroll.employee.won", { amount: fmtNumber(detail.calculation.total_net_won) })
                : "—",
          },
          {
            key: "holds",
            label: t("payroll.run.precheckTitle"),
            value:
              bankHoldCount > 0
                ? t("payroll.run.missingBankChip", { count: bankHoldCount })
                : detail.exceptions_open > 0
                  ? t("payroll.run.attentionChip", { count: detail.exceptions_open })
                  : t("payroll.run.bankRegistered"),
          },
        ]}
      />

      {kind === "closeAttendance" && (
        <>
          {preflight.data && (
            <KeyValue
              density="dense"
              label={t("payrollRun.tool.preflight")}
              items={preflight.data.checks.map((c, i) => ({
                key: `${c.key}-${i}`,
                label: c.label_ko ?? c.key,
                value: (
                  <Chip tone={c.ok ? "ok" : c.warn ? "warn" : "danger"}>
                    {c.ok ? t("enum.checklistState.DONE") : c.warn ? t("attendance.close.warningChip") : t("attendance.close.blockerChip")}
                  </Chip>
                ),
              }))}
            />
          )}
          <Checks
            label={t("payrollRun.cta.closeAttendance")}
            items={[{ id: "attest", label: t("payrollRun.closeAttendance.attest") }]}
            value={attest}
            onChange={setAttest}
          />
        </>
      )}

      {kind === "decide" && (
        <>
          <ChoiceField
            label={t("payrollRun.cta.decide")}
            required
            options={[
              { value: "APPROVE", label: t("payrollRun.decision.approve") },
              { value: "REJECT", label: t("payrollRun.decision.reject") },
            ]}
            value={decision}
            onChange={(next) => setDecision(next as "APPROVE" | "REJECT")}
          />
          <Field label={t("payrollRun.decision.reasonLabel")} required={decision === "REJECT"}>
            {(props) => <TextArea {...props} value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} />}
          </Field>
        </>
      )}

      {kind === "scheduleDisbursement" && (
        <DateField
          label={t("payrollRun.disbursement.scheduledAt")}
          required
          today={today}
          value={scheduledDate}
          onChange={setScheduledDate}
        />
      )}

      {kind === "attestDisbursement" && (
        <>
          <ChoiceField
            label={t("payrollRun.disbursement.statusLabel")}
            required
            options={(["SCHEDULED", "SUBMITTED_TO_BANK", "PAID", "FAILED"] as const).map((status) => ({
              value: status,
              label: t(`payrollRun.disbursement.status.${status}`),
            }))}
            value={disbursementStatus}
            onChange={(next) => setDisbursementStatus(next as DisbursementStatus)}
          />
          {disbursementStatus === "FAILED" && (
            <Field label={t("payrollRun.decision.reasonLabel")} required>
              {(props) => <TextArea {...props} value={disbursementReason} onChange={(e) => setDisbursementReason(e.target.value)} />}
            </Field>
          )}
        </>
      )}

      {kind === "issuePayslips" && !detail.calculation?.payable && (
        <Banner tone="warn">{t("payrollRun.error.legal_gate")}</Banner>
      )}
    </Composer>
  );
}
