// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Download, History } from "lucide-react";
import { t } from "@console/i18n";
import { fmtMonth, fmtNumber } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { ReadReference } from "../../../lib/react/read-reference";
import { readFailureText } from "../../../lib/refusal";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow } from "../../../ui/key-value/key-value";
import { Ledger } from "../../../ui/ledger/ledger";
import { PhoneStatement } from "../../../ui/patterns/phone-statement";
import { PeriodStepper } from "../../../ui/period-stepper/period-stepper";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import { myPayslipDetailQuery, myPayslipsListQuery, type InboxDocSummary } from "../api";
import {
  findDocForMonth,
  formatShortMonthDay,
  parsePayslipPayload,
  payslipMonth,
  selectPayslipDoc,
  stepBoundaries,
} from "../domain/payslip";
import { presentContextStats, presentDeductionRows, presentEarningRows, presentSummaryStats } from "../present";
import { PastPayslipsDialog } from "./past-payslips-dialog";
import { PayslipBaseline } from "./payslip-baseline";
import { printPayslip } from "./payslip-print";
import s from "./payslip-page.module.css";

/** Employee self-service issued payslip statement (`P13` `PhoneStatement` at `/payslips`). */
export function PayslipPage() {
  const search = useSearch({ strict: false }) as { doc?: string; month?: string };
  const navigate = useNavigate();
  const [historyOpen, setHistoryOpen] = useState(false);
  const printCleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      printCleanupRef.current?.();
      printCleanupRef.current = null;
    },
    [],
  );

  const listQuery = useQuery(myPayslipsListQuery);
  const items = listQuery.data?.items ?? [];
  const { active, month } = selectPayslipDoc(items, search);
  const { disablePrev, disableNext, latestDoc } = stepBoundaries(month, items);

  const detailQuery = useQuery({
    ...myPayslipDetailQuery(active?.id ?? ""),
    enabled: Boolean(active?.id),
  });

  const detailView = queryView(detailQuery);
  const detailMatchesActive = Boolean(
    active?.id && !detailQuery.isPlaceholderData && detailQuery.data?.id === active.id,
  );
  const payload = detailMatchesActive ? parsePayslipPayload(detailQuery.data?.payload) : null;
  const displayPayload =
    detailMatchesActive && detailView !== "denied" && detailView !== "not-found" ? payload : null;
  const activePayDate = formatShortMonthDay(active?.payslip_meta?.pay_date ?? displayPayload?.payDate);

  const selectDoc = (doc: InboxDocSummary) => {
    const docMonth = payslipMonth(doc);
    setHistoryOpen(false);
    void navigate({
      to: "/payslips",
      search: docMonth ? { doc: doc.id, month: docMonth } : { doc: doc.id },
    });
  };

  const handleMonthStep = (nextMonth: string) => {
    const matched = findDocForMonth(items, nextMonth);
    void navigate({
      to: "/payslips",
      search: matched ? { doc: matched.id, month: nextMonth } : { month: nextMonth },
    });
  };

  const handleSavePdf = () => {
    if (!displayPayload) return;
    printCleanupRef.current?.();
    printCleanupRef.current = printPayslip(displayPayload, month);
  };

  const periodControl =
    items.length > 0 && month ? (
      <PeriodStepper
        unit="month"
        variant="plain"
        showCurrent={false}
        value={month}
        disablePrev={disablePrev}
        disableNext={disableNext}
        label={t("payslip.period.label")}
        onChange={handleMonthStep}
      />
    ) : undefined;

  const periodMeta = activePayDate ? (
    <>
      {t("payslip.payDateLabel")} <strong className="t-ink t-strong num">{activePayDate}</strong>
    </>
  ) : undefined;

  const emptyListView = (
    <EmptyState title={t("payslip.empty.title")} reason={t("payslip.empty.reason")} />
  );

  const monthEmptyView = (
    <EmptyState
      title={t("payslip.monthEmpty.title", { month: month ? fmtMonth(month) : "" })}
      reason={t("payslip.monthEmpty.reason")}
      actions={
        latestDoc ? (
          <Button variant="primary" onClick={() => selectDoc(latestDoc)}>
            {t("payslip.monthEmpty.latest")}
          </Button>
        ) : undefined
      }
    />
  );

  const detailUnavailable = (
    <EmptyState title={t("payslip.detail.unavailable")} reason={null} />
  );

  const heroContent =
    items.length === 0 ? (
      emptyListView
    ) : !active ? (
      monthEmptyView
    ) : (
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
          displayPayload ? (
            <div className={s.heroWrap}>
              <div className="t-xs muted">{t("payslip.netPay")}</div>
              <div className="t-2xl t-strong num">
                {t("payslip.netAmount", { amount: fmtNumber(displayPayload.netWon) })}
              </div>
            </div>
          ) : (
            detailUnavailable
          )
        }
      </QueryState>
    );

  const contextItems = displayPayload ? presentContextStats(displayPayload) : [];

  const actionButtons =
    items.length > 0 ? (
      <>
        <Button
          variant="primary"
          size="lg"
          disabled={!displayPayload}
          onClick={handleSavePdf}
        >
          <Download size={16} aria-hidden="true" />
          {t("payslip.action.savePdf")}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => setHistoryOpen(true)}
        >
          <History size={16} aria-hidden="true" />
          {t("payslip.action.past")}
        </Button>
      </>
    ) : undefined;

  const historyOverlay = (
    <PastPayslipsDialog
      open={historyOpen}
      items={items}
      activeId={active?.id ?? null}
      onSelect={selectDoc}
      onClose={() => setHistoryOpen(false)}
    />
  );

  return (
    <PhoneStatement
      q={listQuery}
      head={{ title: t("payslip.title"), titleId: "payslip-title" }}
      period={periodControl}
      periodMeta={periodMeta}
      hero={heroContent}
      stats={
        displayPayload ? (
          <StatRow items={presentSummaryStats(displayPayload)} label={t("payslip.statsLabel")} />
        ) : undefined
      }
      ledgers={
        displayPayload ? (
          <>
            <Ledger
              title={t("payslip.earnings")}
              unit={t("payslip.unitWon")}
              headerSurface="muted"
              detailLayout="inline"
              rows={presentEarningRows(displayPayload)}
              totals={[
                {
                  key: "gross",
                  label: t("payslip.grossTotal"),
                  amount: fmtNumber(displayPayload.grossWon),
                  numericValue: displayPayload.grossWon,
                  kind: "total",
                },
              ]}
            />
            <Ledger
              title={t("payslip.deductions")}
              unit={t("payslip.unitWon")}
              headerSurface="muted"
              detailLayout="inline"
              rows={presentDeductionRows(displayPayload)}
              empty={t("payslip.deductionsEmpty")}
              totals={[
                {
                  key: "deductions",
                  label: t("payslip.deductionsTotal"),
                  amount: fmtNumber(displayPayload.totalDeductionsWon),
                  numericValue: displayPayload.totalDeductionsWon,
                  kind: "total",
                },
              ]}
            />
          </>
        ) : null
      }
      contextStats={
        contextItems.length > 0 ? (
          <StatRow items={contextItems} label={t("payslip.context.label")} />
        ) : undefined
      }
      actions={actionButtons}
      overlays={historyOverlay}
      baseline={() => (
        <PayslipBaseline
          listQuery={listQuery}
          detailQuery={detailQuery}
          hasActiveDoc={Boolean(active)}
          period={periodControl}
          periodMeta={periodMeta}
          payload={displayPayload}
          emptyContent={items.length === 0 ? emptyListView : !active ? monthEmptyView : detailUnavailable}
          actions={actionButtons}
          overlays={historyOverlay}
        />
      )}
    />
  );
}
