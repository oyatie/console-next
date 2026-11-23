// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import type { ReadState } from "../../lib/react/query-view";
import type { MenuAction } from "../menu/action-menu";
import type { PageHeadProps } from "../page-head/page-head";
import type { PaneGrid } from "../pane-grid/pane-grid";
import type { useScreenStatusBar } from "../status-bar/status-bar-store";

/** Only redundant summary facts may be omitted by an arrangement without a style-specific ruling. */
export const worklistOptionalRegions = ["facts"] as const;

type LazyRegion = ReactNode | (() => ReactNode);

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
  list: LazyRegion;
  /** Optional schedule strip (`DeadlineStrip`), evaluated only when placed by the active experience. */
  schedule?: LazyRegion;
  /** Optional operational summary bands, evaluated only when placed by the active experience. */
  bands?: LazyRegion;
  /** Lock desktop viewport height to `100dvh` with independent pane scrolling when no lower bands stack below. */
  viewportLock?: boolean;
  /** Status-bar segments published while the worklist is mounted in an experience with a status bar. */
  statusSegments?: Parameters<typeof useScreenStatusBar>[0];
  /** Temporary Classic (`baseline`) fallback renderer kept until Phase 7 deletes `baseline`. */
  baseline?: () => ReactNode;
} & Partial<
    Record<"tabs" | "views" | "find" | "filters" | "tools" | "stats" | "notes" | "foot" | "facts" | "overlays", ReactNode>
  >;
