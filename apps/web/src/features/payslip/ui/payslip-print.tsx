// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { i18n, t } from "@console/i18n";
import { fmtDate, fmtMonth, fmtNumber } from "@console/i18n/format";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Ledger } from "../../../ui/ledger/ledger";
import type { PayslipPayload } from "../domain/payslip";
import { presentContextStats, presentDeductionRows, presentEarningRows } from "../present";

/** Builds a standalone printable payslip document via React static markup (no raw HTML concatenation). */
export function buildPayslipPrintHtml(payload: PayslipPayload, fallbackMonth: string | null): string {
  const month = payload.attributionMonth ?? fallbackMonth;
  const heading = month ? `${fmtMonth(month)} ${t("payslip.title")}` : t("payslip.title");
  const periodRange =
    payload.periodStart && payload.periodEnd
      ? t("payslip.print.periodRange", {
          start: fmtDate(payload.periodStart),
          end: fmtDate(payload.periodEnd),
        })
      : null;

  const summaryItems = [
    ...(payload.employeeDisplayName
      ? [{ key: "employee", label: t("payslip.print.employee"), value: payload.employeeDisplayName }]
      : []),
    ...(payload.employeeNumber
      ? [{ key: "employeeNumber", label: t("payslip.print.employeeNumber"), value: payload.employeeNumber }]
      : []),
    ...(payload.employeeCompany
      ? [{ key: "company", label: t("payslip.print.company"), value: payload.employeeCompany }]
      : []),
    ...(payload.orgUnit
      ? [{ key: "orgUnit", label: t("payslip.print.orgUnit"), value: payload.orgUnit }]
      : []),
    ...(payload.position
      ? [{ key: "position", label: t("payslip.print.position"), value: payload.position }]
      : []),
    ...(periodRange
      ? [{ key: "period", label: t("payslip.print.period"), value: periodRange }]
      : []),
    ...(payload.payDate
      ? [{ key: "payDate", label: t("payslip.payDateLabel"), value: fmtDate(payload.payDate) }]
      : []),
    {
      key: "net",
      label: t("payslip.netPay"),
      value: t("payslip.netAmount", { amount: fmtNumber(payload.netWon) }),
    },
  ];

  const contextItems = presentContextStats(payload).map(item => ({
    key: item.key,
    label: item.label,
    value: item.meta ? `${item.value} (${item.meta})` : item.value,
  }));

  const doc = renderToStaticMarkup(
    <html lang={i18n.locale}>
      <head>
        <meta charSet="utf-8" />
        <title>{heading}</title>
        <link rel="stylesheet" href="/payslip-print.css" />
      </head>
      <body>
        <header>
          <div role="heading" aria-level={1} className="print-title">{heading}</div>
          {payload.employeeCompany ? <div className="meta">{payload.employeeCompany}</div> : null}
        </header>
        <KeyValue readOnly label={heading} items={summaryItems} />
        <Ledger
          level={2}
          title={t("payslip.earnings")}
          unit={t("payslip.unitWon")}
          headerSurface="muted"
          detailLayout="inline"
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
        <Ledger
          level={2}
          title={t("payslip.deductions")}
          unit={t("payslip.unitWon")}
          headerSurface="muted"
          detailLayout="inline"
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
        {contextItems.length > 0 ? (
          <KeyValue readOnly label={t("payslip.context.label")} items={contextItems} />
        ) : null}
      </body>
    </html>,
  );

  return `<!doctype html>${doc}`;
}

/** Opens a hidden sandboxed print frame so mobile/desktop chrome never leaks onto the saved PDF. */
export function printPayslip(payload: PayslipPayload, fallbackMonth: string | null) {
  const frame = document.createElement("iframe");
  frame.className = "sr-only";
  frame.setAttribute("aria-hidden", "true");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    frame.remove();
  };
  frame.onload = () => {
    const win = frame.contentWindow;
    win?.addEventListener("afterprint", cleanup, { once: true });
    win?.focus();
    win?.print();
    setTimeout(cleanup, 1500);
  };
  frame.srcdoc = buildPayslipPrintHtml(payload, fallbackMonth);
  document.body.append(frame);
}
