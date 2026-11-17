// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import type { ReadState } from "../../lib/react/query-view";
import type { FlexibleColumns } from "../flexible-columns/flexible-columns";
import type { MenuAction } from "../menu/action-menu";
import type { PageHeadProps } from "../page-head/page-head";

/** Only redundant facts may be omitted without a pack-specific owner ruling. */
export const listRecordOptionalRegions = ["facts"] as const;

/**
 * Content keeps its roles across arrangements: list is a grid; status views are pressed buttons;
 * route tabs are links with aria-current; overlays use Sheet/Dialog. FlexibleColumns owns the named
 * complementary record/related regions, closing and return focus. Page owns the one h1 in main.
 * Facts carry the position, selection and sort sentence; selection commands stay inside the grid.
 */
export type ListRecordProps = Pick<ComponentProps<typeof FlexibleColumns>, "list" | "record" | "related" | "full" | "onFull" | "onSelect" | "onOpen" | "onFind"> & {
  q: ReadState;
  head: Pick<PageHeadProps, "title" | "titleId" | "asOf" | "actions"> & {
    primary?: MenuAction;
    commands?: { label: string; items: readonly MenuAction[] };
  };
} & Partial<Record<"tabs" | "views" | "find" | "filters" | "tools" | "notes" | "foot" | "facts" | "overlays", ReactNode>>;
