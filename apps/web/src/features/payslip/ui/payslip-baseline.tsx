// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import type { ReadState } from "../../../lib/react/query-view";
import { Card } from "../../../ui/card/card";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { Ledger } from "../../../ui/ledger/ledger";
import { Page } from "../../../ui/page/page";
import type { PayslipPayload } from "../domain/payslip";
import { presentContextStats, presentDeductionRows, presentEarningRows, presentSummaryStats } from "../present";
import s from "./payslip-page.module.css";

/** Classic (`baseline`) fallback renderer for `/payslips`, keeping baseline layout unaltered until Phase 7. */
export function PayslipBaseline({
  listQuery,
  period,
  periodMeta,
  payload,
  emptyContent,
  actions,
  overlays,
}: {
  listQuery: ReadState;
  period?: ReactNode;
  periodMeta?: ReactNode;
  payload: PayslipPayload | null;
  emptyContent: ReactNode;
  actions?: ReactNode;
  overlays?: ReactNode;
}) {
  const contextItems = payload ? presentContextStats(payload) : [];
  return (
    <Page floorplan="P-02" q={listQuery} head={{ title: t("payslip.title"), titleId: "payslip-title" }} layout="record">
      {() => (
        <div className={s.baselineWrap}>
          {overlays}
          {period ? (
            <Card>
              <div className={s.baselinePeriod}>
                {period}
                {periodMeta ? <div className="t-xs muted num">{periodMeta}</div> : null}
              </div>
            </Card>
          ) : null}
          {payload ? (
            <>
              <Card title={t("payslip.netPay")}>
                <KeyValue
                  readOnly
                  items={[
                    {
                      key: "net",
                      label: t("payslip.netPay"),
                      value: t("payslip.netAmount", { amount: fmtNumber(payload.netWon) }),
                    },
                  ]}
                />
                <StatRow items={presentSummaryStats(payload)} label={t("payslip.statsLabel")} />
              </Card>
              <Card>
                <Ledger
                  title={t("payslip.earnings")}
                  unit={t("payslip.unitWon")}
                  rows={presentEarningRows(payload)}
                  totals={[
                    {
                      key: "gross",
                      label: t("payslip.grossTotal"),
                      amount: fmtNumber(payload.grossWon),
                      numericValue: payload.grossWon,
                      kind: "total",
                    },
                  ]}
                />
              </Card>
              <Card>
                <Ledger
                  title={t("payslip.deductions")}
                  unit={t("payslip.unitWon")}
                  rows={presentDeductionRows(payload)}
                  empty={t("payslip.deductionsEmpty")}
                  totals={[
                    {
                      key: "deductions",
                      label: t("payslip.deductionsTotal"),
                      amount: fmtNumber(payload.totalDeductionsWon),
                      numericValue: payload.totalDeductionsWon,
                      kind: "total",
                    },
                  ]}
                />
              </Card>
              {contextItems.length > 0 ? (
                <Card>
                  <StatRow items={contextItems} label={t("payslip.context.label")} />
                </Card>
              ) : null}
            </>
          ) : (
            <Card>{emptyContent}</Card>
          )}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      )}
    </Page>
  );
}
