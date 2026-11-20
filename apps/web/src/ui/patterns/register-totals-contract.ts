// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import type { PaneGrid } from "../pane-grid/pane-grid";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const registerTotalsOptionalRegions = ["facts"] as const;

/**
 * RegisterTotals (`P6`) page contract: arranges a payroll or statutory register with a command strip, a flush
 * `totals` band (stage `StepLine` + aggregate `StatRow`), an optional `blockers` pre-check strip (omitted when
 * clear), a horizontally bounded `register` table with pinned totals, an optional lower `preview` (`PaneGrid`
 * `bottom`), and optional `record` / `related` side panes.
 */
export type RegisterTotalsProps = PatternBaseProps &
  Pick<ComponentProps<typeof PaneGrid>, "record" | "related" | "full" | "onFull" | "onSelect" | "onOpen"> & {
    /** Optional flush stage + aggregate totals strip directly beneath the command strip. */
    totals?: ReactNode;
    /** Optional pre-check / blocker / advisory strip; omit completely when zero items apply. */
    blockers?: ReactNode;
    /** Primary grouped register table inside `PaneGrid` `main`. */
    register: ReactNode;
    /** Optional lower preview pane (`PaneGrid` `bottom`), e.g. 3-column `Ledger` payslip preview. */
    preview?: ReactNode;
  };
