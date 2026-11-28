// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button-base";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { TextArea } from "../../../ui/field/text-area";
import { Table } from "../../../ui/table";
import {
  payrollClosePreflightQuery,
  payrollExceptionsQuery,
  payrollPayslipDeliveryQuery,
  resolvePayrollException,
  type PayrollException,
} from "../api";
import { payrollErrorMessageKey } from "../domain/run-lifecycle";
import type { PayrollRunDetail } from "../domain/run-register";
import s from "./payroll-console.module.css";

export type RunSideTab = "preflight" | "exceptions" | "delivery";

const ownError = (code: string) => {
  const key = payrollErrorMessageKey(code);
  return key && isMessageId(key) ? t(key) : undefined;
};

const SEVERITY_ORDER = { danger: 0, warn: 1, info: 2 } as const;

export function RunLifecyclePane({
  tab,
  detail,
  onSelectLine,
}: {
  tab: RunSideTab;
  detail: PayrollRunDetail;
  onSelectLine: (lineId: string) => void;
}) {
  const preflight = useQuery({
    ...payrollClosePreflightQuery(detail.run.id),
    enabled: tab === "preflight",
  });
  const exceptions = useQuery({
    ...payrollExceptionsQuery(detail.run.id, { limit: 50 }),
    enabled: tab === "exceptions",
  });
  const delivery = useQuery({
    ...payrollPayslipDeliveryQuery(detail.run.id, { limit: 50 }),
    enabled: tab === "delivery",
  });
  const [holdTarget, setHoldTarget] = useState<PayrollException | null>(null);
  const [holdReason, setHoldReason] = useState("");

  const resolveCmd = useCommand({
    run: ({ exceptionId, action, reason }: { exceptionId: string; action: "CONFIRM" | "HOLD"; reason?: string }) =>
      resolvePayrollException(detail.run.id, exceptionId, { action, ...(reason ? { reason } : {}) }),
    invalidates: ["/api/v1/payroll"],
    awaitFirstRead: true,
    announce: () => t("payrollRun.exceptions.resolvedDone"),
    onSuccess: () => {
      setHoldTarget(null);
      setHoldReason("");
    },
  });

  if (tab === "preflight") {
    return (
      <div className={s.paneDetail}>
        <QueryState q={preflight} compact>
          {(data) => (
            <Card title={t("payrollRun.tool.preflight")}>
              <KeyValue
                density="dense"
                label={t("payrollRun.tool.preflight")}
                items={data.checks.map((c, idx) => ({
                  key: `${c.key}-${idx}`,
                  label: c.key === "workplace_attendance_close" ? t("payroll.preflight.workplaceClose") : (c.label_ko ?? c.key),
                  value: (
                    <Chip tone={c.ok && !c.warn ? "ok" : c.warn ? "warn" : "danger"}>
                      {c.ok && !c.warn ? t("enum.checklistState.DONE") : c.warn ? t("attendance.close.warningChip") : t("attendance.close.blockerChip")}
                    </Chip>
                  ),
                }))}
              />
            </Card>
          )}
        </QueryState>
      </div>
    );
  }

  if (tab === "delivery") {
    return (
      <div className={s.paneDetail}>
        {detail.disbursement && (
          <Card title={t("payrollRun.delivery.title")}>
            <KeyValue
              density="dense"
              label={t("payrollRun.delivery.title")}
              items={[
                {
                  key: "status",
                  label: t("payrollRun.disbursement.statusLabel"),
                  value: (
                    <Chip tone={detail.disbursement.status === "PAID" ? "ok" : detail.disbursement.status === "FAILED" ? "danger" : "info"}>
                      {t(`payrollRun.disbursement.status.${detail.disbursement.status}`)}
                    </Chip>
                  ),
                },
                { key: "scheduled", label: t("payrollRun.disbursement.scheduledAt"), value: fmtDateTime(detail.disbursement.scheduled_at) },
                ...(detail.disbursement.attested_at
                  ? [{ key: "attested", label: t("attendance.close.pane.attestedAt"), value: fmtDateTime(detail.disbursement.attested_at) }]
                  : []),
              ]}
            />
          </Card>
        )}
        <QueryState q={delivery} compact>
          {(summary) => (
            <Card title={t("payrollRun.delivery.issuedCount", { issued: summary.issued, acknowledged: summary.acknowledged })}>
              {summary.items.length === 0 ? (
                <Banner tone="info">{t("payrollRun.delivery.empty")}</Banner>
              ) : (
                <Table
                  label={t("payrollRun.delivery.title")}
                  rows={summary.items}
                  rowId={(item) => item.inbox_doc_id}
                  density="compact"
                  mobileLayout="compact"
                  columns={[
                    { header: t("payroll.run.col.name"), card: "title", cell: (item) => item.employee_id.slice(0, 8) },
                    { header: t("attendance.close.closedAt"), card: "fact", cell: (item) => fmtDateTime(item.issued_at) },
                  ]}
                />
              )}
              <div className={s.headActions}>
                <Link to="/statutory" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>
                  {t("payrollRun.tool.statutory")}
                </Link>
              </div>
            </Card>
          )}
        </QueryState>
      </div>
    );
  }

  const confirmException = (exc: PayrollException) => {
    resolveCmd.mutate({ exceptionId: exc.id, action: "CONFIRM" });
  };

  return (
    <div className={s.paneDetail}>
      <CommandError error={resolveCmd.error} own={ownError} />
      <QueryState q={exceptions} compact>
        {(page) => {
          const sorted = [...page.items].sort((a, b) => {
            if (a.status !== b.status) return a.status === "OPEN" ? -1 : b.status === "OPEN" ? 1 : 0;
            return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
          });
          if (sorted.length === 0) {
            return <Banner tone="info">{t("payrollRun.exceptions.empty")}</Banner>;
          }
          return (
            <div className={s.sectionStack}>
              {sorted.map((exc) => (
                <Card
                  key={exc.id}
                  title={exc.employee_display_name}
                  tools={
                    <Chip tone={exc.status === "OPEN" ? (exc.severity === "danger" ? "danger" : "warn") : "ok"}>
                      {exc.status}
                    </Chip>
                  }
                >
                  <div className={s.sectionStack}>
                    <div>{exc.summary_ko}</div>
                    {exc.amount_delta_won != null && (
                      <div className="muted">{t("payroll.employee.won", { amount: fmtNumber(exc.amount_delta_won) })}</div>
                    )}
                    <div className={s.headActions}>
                      {exc.status === "HELD" && <Chip tone="info">{t("payroll.run.heldPaid")}</Chip>}
                      {exc.carried_from_run_id && <Chip tone="info">{t("payrollRun.exceptions.carried")}</Chip>}
                      {exc.line_id && (
                        <Button size="sm" variant="ghost" className={s.nowrap} onClick={() => onSelectLine(exc.line_id!)}>
                          {t("payroll.run.openCard")}
                        </Button>
                      )}
                      {exc.status === "OPEN" && (
                        <>
                          <Button
                            size="sm"
                            variant="primary"
                            className={s.nowrap}
                            disabled={resolveCmd.isPending}
                            onClick={() => confirmException(exc)}
                          >
                            {t("payrollRun.exceptions.confirm")}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            className={s.nowrap}
                            disabled={resolveCmd.isPending}
                            onClick={() => {
                              setHoldTarget(exc);
                              setHoldReason("");
                            }}
                          >
                            {t("payrollRun.exceptions.hold")}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          );
        }}
      </QueryState>
      {holdTarget && (
        <Composer
          open
          title={t("payrollRun.exceptions.hold")}
          subtitle={holdTarget.employee_display_name}
          action={{ kind: "payrollRun", mode: "record" }}
          onClose={() => setHoldTarget(null)}
          pending={resolveCmd.isPending}
          error={resolveCmd.error}
          notice={<CommandError error={resolveCmd.error} own={ownError} />}
          dirty={Boolean(holdReason)}
          blocked={!holdReason.trim() ? { reason: t("payrollRun.exceptions.holdReason") } : undefined}
          onSubmit={() => {
            resolveCmd.mutate({ exceptionId: holdTarget.id, action: "HOLD", reason: holdReason.trim() });
          }}
        >
          <Field label={t("payrollRun.exceptions.holdReason")} required>
            {(props) => <TextArea {...props} value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />}
          </Field>
        </Composer>
      )}
    </div>
  );
}
