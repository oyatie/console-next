// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { ReadState } from "../../lib/react/query-view";
import type { FlexibleColumns } from "../flexible-columns/flexible-columns";
import type { MenuAction } from "../menu/action-menu";
import type { PageHeadProps } from "../page-head/page-head";
import type { SidePaneSpec } from "../pane-grid/pane-grid-side";
import type { useScreenStatusBar } from "../status-bar/status-bar-store";

/** Only redundant facts may be omitted without a pack-specific owner ruling. */
export const listRecordOptionalRegions = ["facts"] as const;

export type ListRecordPane = SidePaneSpec & {
  crumb?: ReactNode;
  expand?: ReactNode;
};

/**
 * Content keeps its roles across arrangements: list is a grid; status views are pressed buttons;
 * route tabs are links with aria-current; overlays use Sheet/Dialog. FlexibleColumns / PaneGrid owns the named
 * complementary record/related regions, closing and return focus. Page owns the one h1 in main.
 * Facts carry the position, selection and sort sentence; selection commands stay inside the grid.
 * Overlays stay mounted while the list read loads or fails. Use overlays only for sheets and dialogs
 * that work independently of the read. Put list data consumers and list shortcuts in notes, list or foot.
 */
export type ListRecordProps = Pick<ComponentProps<typeof FlexibleColumns>, "list" | "full" | "onFull" | "onSelect" | "onOpen" | "onFind"> & {
  q: ReadState;
  head: Pick<PageHeadProps, "title" | "titleId" | "meta" | "asOf" | "actions"> & {
    /** The one primary action, or the screen's own button when it has a state of its own (waiting, or unavailable with a reason). */
    primary?: MenuAction | ReactElement;
    commands?: { label: string; items: readonly MenuAction[] };
  };
  record?: ListRecordPane | false | "" | null;
  related?: ListRecordPane | false | "" | null;
  statusSegments?: Parameters<typeof useScreenStatusBar>[0];
  /** Beside the retry when the list read fails: what that failure stops, such as the primary's reason. */
  failedActions?: ReactNode;
  baseline?: () => ReactNode;
} & Partial<Record<"tabs" | "views" | "find" | "filters" | "tools" | "stats" | "rail" | "indexBar" | "notes" | "foot" | "facts" | "overlays", ReactNode>>;
