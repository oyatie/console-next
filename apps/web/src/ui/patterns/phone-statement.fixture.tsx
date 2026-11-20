// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { StatRow } from "../key-value/key-value";
import { Ledger } from "../ledger/ledger";
import { PeriodStepper } from "../period-stepper/period-stepper";
import { PhoneStatement } from "./phone-statement";
import fx from "./pattern-fixture.module.css";

const READY: ReadState = { isPending: false, error: null, data: { period: "2026-10" }, refetch() {} };
const NET_AMOUNT = "3,141,755";

/** Synthetic no-network showcase for PhoneStatement (`P13`). */
export default function PhoneStatementExample({ q = READY }: { q?: ReadState }) {
  const [period, setPeriod] = useState("2026-10");

  return (
    <PhoneStatement
      q={q}
      head={{ title: t("payroll.title"), titleId: "phone-statement-title" }}
      period={<PeriodStepper unit="month" variant="plain" showCurrent={false} value={period} onChange={setPeriod} />}
      periodMeta={`${t("payroll.create.payDate")} 11-25`}
      hero={
        <div>
          <div className={fx.stageLabel}>{t("payroll.employee.net")}</div>
          <div className={fx.heroFigure}>{NET_AMOUNT}</div>
        </div>
      }
      stats={
        <StatRow
          label={t("payroll.title")}
          items={[
            { key: "gross", label: t("payroll.employee.gross"), value: "3,567,000" },
            { key: "ded", label: `− ${t("payroll.employee.deductions")}`, value: "425,245" },
          ]}
        />
      }
      ledgers={
        <>
          <Ledger
            title={t("payroll.employee.earnings")}
            unit={t("profile.won")}
            headerSurface="muted"
            detailLayout="inline"
            rows={[
              { key: "base", label: t("payroll.employee.wage"), amount: "3,100,000", numericValue: 3100000 },
              {
                key: "ot",
                label: t("attendance.tab.overtime"),
                detail: t("attendance.hours", { hours: 12 }),
                amount: "267,000",
                numericValue: 267000,
              },
            ]}
            totals={[{ key: "tot", label: t("payroll.employee.gross"), amount: "3,567,000", kind: "total" }]}
          />
          <Ledger
            title={t("payroll.employee.deductions")}
            unit={t("profile.won")}
            headerSurface="muted"
            detailLayout="inline"
            rows={[
              { key: "pen", label: t("enum.insurer.NPS"), amount: "151,515", numericValue: 151515 },
              { key: "hlt", label: t("enum.insurer.NHIS"), amount: "119,360", numericValue: 119360 },
            ]}
            totals={[{ key: "tot", label: t("payroll.employee.insuranceTotal"), amount: "425,245", kind: "total" }]}
          />
        </>
      }
      contextStats={
        <StatRow
          label={t("attendanceRecords.card.workedDays")}
          items={[
            {
              key: "work",
              label: t("attendanceRecords.card.workedDays"),
              value: "22",
              meta: `${t("attendance.dayKind.WORK")} 18 · ${t("attendance.dayKind.WEEKLY_HOLIDAY")} 4`,
            },
            { key: "leave", label: t("people.field.leave"), value: "0" },
          ]}
        />
      }
      actions={
        <>
          <Button variant="primary" size="lg">
            {t("statutory.pdf")}
          </Button>
          <Button variant="secondary" size="lg">
            {t("orgChange.list.title")}
          </Button>
        </>
      }
    />
  );
}
