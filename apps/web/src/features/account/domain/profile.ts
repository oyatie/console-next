// SPDX-License-Identifier: LicenseRef-Proprietary

interface PayslipSummaryLike {
  title: string;
  payslip_meta?: {
    attribution_month?: string | null;
    period_end?: string | null;
  } | null;
}

/** Extract the attribution month (YYYY-MM) from an inbox payslip summary when available. */
export function payslipMonthSource(doc: PayslipSummaryLike): string | null {
  const meta = doc.payslip_meta;
  return meta?.attribution_month ?? meta?.period_end?.slice(0, 7) ?? /\d{4}-\d{2}/.exec(doc.title)?.[0] ?? null;
}
