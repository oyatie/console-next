// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { queryView, type ReadState } from "../../../lib/react/query-view";
import { ReadReference } from "../../../lib/react/read-reference";
import { readFailureText } from "../../../lib/refusal";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { Ledger } from "../../../ui/ledger/ledger";
import { Page } from "../../../ui/page/page";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import type { PayslipPayload } from "../domain/payslip";
import { presentContextStats, presentDeductionRows, presentEarningRows, presentSummaryStats } from "../present";
import s from "./payslip-page.module.css";

/** Classic (`baseline`) fallback renderer for `/payslips`, keeping baseline layout unaltered until Phase 7. */
export function PayslipBaseline({
  listQuery,
  detailQuery,
  hasActiveDoc,
  period,
  periodMeta,
  payload,
  emptyContent,
  actions,
  overlays,
}: {
  listQuery: ReadState;
  detailQuery: ReadState;
  hasActiveDoc: boolean;
  period?: ReactNode;
  periodMeta?: ReactNode;
  payload: PayslipPayload | null;
  emptyContent: ReactNode;
  actions?: ReactNode;
  overlays?: ReactNode;
}) {
  const contextItems = payload ? presentContextStats(payload) : [];
  const detailView = queryView(detailQuery);
  const renderDetailCardsDirectly =
    Boolean(payload) &&
    (detailView === "ready" || detailView === "stale" || (detailView === "offline" && detailQuery.data !== undefined));

  const detailQueryState = (
    <QueryState
      q={detailQuery}
      loading={<Skeleton bones={["short", "title"]} label={t("common.loading")} />}
      denied={
        <EmptyState
          title={t("common.denied.panel")}
          reason={detailQuery.error ? readFailureText(detailQuery.error) : null}
          meta={<ReadReference error={detailQuery.error} />}
        />
      }
    >
      {() =>
        payload ? (
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
          emptyContent
        )
      }
    </QueryState>
  );

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
          {hasActiveDoc ? (
            renderDetailCardsDirectly ? (
              detailQueryState
            ) : (
              <Card>{detailQueryState}</Card>
            )
          ) : (
            <Card>{emptyContent}</Card>
          )}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      )}
    </Page>
  );
}
