// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import type { PaneGrid } from "../pane-grid/pane-grid";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const monthGridOptionalRegions = ["facts"] as const;

/**
 * MonthGrid (`P5`) page contract: arranges a monthly attendance/schedule matrix (`PersonDayGrid` or `MonthGrid`)
 * under a merged command strip (`PageHead` with `PeriodStepper`, scope selector, and filters), an optional flush
 * `summary` `StatRow` strip, an optional `bottom` split region (exceptions + aggregation legend), and `PaneGrid`
 * `record` / `related` inspection docks.
 */
export type MonthGridPatternProps = PatternBaseProps &
  Pick<ComponentProps<typeof PaneGrid>, "record" | "related" | "full" | "onFull" | "onSelect" | "onOpen"> & {
    /** Optional flush summary strip (`StatRow`) directly beneath the command strip. */
    summary?: ReactNode;
    /** Primary matrix (`PersonDayGrid` or `MonthGrid`) inside `PaneGrid` `main`. */
    grid: ReactNode;
    /** Optional lower split panel (`PaneGrid` `bottom`): e.g. exceptions table + aggregation rules/legend. */
    bottom?: ReactNode;
  };
