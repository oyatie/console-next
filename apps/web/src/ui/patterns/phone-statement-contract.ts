// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const phoneStatementOptionalRegions = ["facts"] as const;

/**
 * PhoneStatement (`P13`) page contract: arranges a period-stepped personal statement (e.g. mobile payslip)
 * with a `PagePhoneHeader`-aware `head`, `period` stepper bar, `hero` net-amount band, top summary `stats`,
 * stacked `ledgers` (`Ledger`), optional `contextStats`, and equal-width footer `actions`.
 */
export type PhoneStatementProps = PatternBaseProps & {
  /** Period selector bar (typically `PeriodStepper` `variant="plain"`). */
  period?: ReactNode;
  /** Trailing metadata inside the period bar (e.g. pay date). */
  periodMeta?: ReactNode;
  /** Prominent hero net-amount band. */
  hero: ReactNode;
  /** Flush summary `StatRow` directly beneath `hero` (e.g. gross earnings vs total deductions). */
  stats?: ReactNode;
  /** Stacked itemized `Ledger` sections. */
  ledgers: ReactNode;
  /** Optional contextual `StatRow` beneath `ledgers` (e.g. worked days and leave used). */
  contextStats?: ReactNode;
  /** Equal-width bottom action buttons (e.g. download PDF, prior statements). */
  actions?: ReactNode;
};
