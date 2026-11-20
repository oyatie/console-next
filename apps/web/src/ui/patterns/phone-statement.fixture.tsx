// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { tg } from "@console/i18n/gallery";
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
      head={{ title: tg("pat.stmt.head"), titleId: "phone-statement-title" }}
      period={<PeriodStepper unit="month" variant="plain" showCurrent={false} value={period} onChange={setPeriod} />}
      periodMeta={tg("pat.stmt.payDate")}
      hero={
        <div>
          <div className={fx.stageLabel}>{tg("pat.stmt.netLabel")}</div>
          <div className={fx.heroFigure}>{NET_AMOUNT}</div>
        </div>
      }
      stats={
        <StatRow
          label={tg("pat.stmt.head")}
          items={[
            { key: "gross", label: tg("pat.reg.gross"), value: "3,567,000" },
            { key: "ded", label: tg("pat.reg.deduct"), value: "425,245" },
          ]}
        />
      }
      ledgers={
        <>
          <Ledger
            title={tg("pat.stmt.earnings")}
            unit={tg("ledger.unit")}
            headerSurface="muted"
            detailLayout="inline"
            rows={[
              { key: "base", label: tg("pat.stmt.basePay"), amount: "3,100,000", numericValue: 3100000 },
              {
                key: "ot",
                label: tg("pat.stmt.overtime"),
                detail: tg("ledger.overtimePhone"),
                amount: "267,000",
                numericValue: 267000,
              },
              {
                key: "meal",
                label: tg("ledger.meal"),
                detail: tg("ledger.taxExempt"),
                amount: "200,000",
                numericValue: 200000,
              },
            ]}
            totals={[{ key: "tot", label: tg("pat.reg.gross"), amount: "3,567,000", kind: "total" }]}
          />
          <Ledger
            title={tg("pat.stmt.deductions")}
            unit={tg("ledger.unit")}
            headerSurface="muted"
            detailLayout="inline"
            rows={[
              { key: "pen", label: tg("pat.stmt.pension"), amount: "151,515", numericValue: 151515 },
              { key: "hlt", label: tg("pat.stmt.health"), amount: "119,360", numericValue: 119360 },
            ]}
            totals={[{ key: "tot", label: tg("ledger.deductionTotal"), amount: "425,245", kind: "total" }]}
          />
        </>
      }
      contextStats={
        <StatRow
          label={tg("pat.stmt.workDays")}
          items={[
            { key: "work", label: tg("pat.stmt.workDays"), value: "22d", meta: tg("pat.stmt.workDaysMeta") },
            { key: "leave", label: tg("pat.stmt.leaveDays"), value: "0d" },
          ]}
        />
      }
      actions={
        <>
          <Button variant="primary" size="lg">
            {tg("pat.stmt.pdf")}
          </Button>
          <Button variant="secondary" size="lg">
            {tg("pat.stmt.past")}
          </Button>
        </>
      }
    />
  );
}
