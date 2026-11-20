// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import type { ReadState } from "../../lib/react/query-view";
import type { MenuAction } from "../menu/action-menu";
import type { PageHeadProps } from "../page-head/page-head";
import type { PaneGrid } from "../pane-grid/pane-grid";

/** Only redundant summary facts may be omitted by an arrangement without a style-specific ruling. */
export const worklistOptionalRegions = ["facts"] as const;

/**
 * Worklist (`P1`) page contract: arranges an actionable queue (`list`) with command-strip `views`, `filters`, `find`,
 * and `tools`, optional `schedule` (`DeadlineStrip`) and operational `bands` beneath the queue, and a `PaneGrid`
 * `record` / `related` side pane for in-place inspection and decisions.
 * `PageHead` owns the single `h1` in `main`; `PaneGrid` owns complementary `aside` panes, splitter resize, Escape
 * dismissal, and return focus; `overlays` stay mounted across loading and failure and unmount on `403` refusal.
 */
export type WorklistProps = Pick<
  ComponentProps<typeof PaneGrid>,
  "record" | "related" | "full" | "onFull" | "onSelect" | "onOpen"
> & {
  q: ReadState;
  head: Pick<PageHeadProps, "title" | "titleId" | "asOf" | "actions"> & {
    primary?: MenuAction;
    commands?: { label: string; items: readonly MenuAction[] };
  };
  /** Primary actionable worklist table, setup checklist, or empty state. */
  list: ReactNode;
} & Partial<
    Record<
      "tabs" | "views" | "find" | "filters" | "tools" | "notes" | "schedule" | "bands" | "foot" | "facts" | "overlays",
      ReactNode
    >
  >;
