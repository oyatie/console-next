// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import type { PaneGrid } from "../pane-grid/pane-grid";
import type { SidePaneSpec } from "../pane-grid/pane-grid-side";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const canvasOptionalRegions = ["facts"] as const;

/**
 * Canvas (`P10`) page contract: arranges a viewport-locked pan/zoom canvas (`OrgCanvas`) with a shared `toolbar`,
 * primary `canvas` stage, and an optional node/item `inspector` (`SidePaneSpec` in `PaneGrid` or docked `<aside>`).
 */
export type CanvasPatternProps = PatternBaseProps &
  Pick<ComponentProps<typeof PaneGrid>, "related" | "full" | "onFull" | "onSelect" | "onOpen"> & {
    /** Optional shared toolbar strip beneath `PageHead` (as-of date, compare, search, fold, add). */
    toolbar?: ReactNode;
    /** Required interactive canvas surface (e.g. `OrgCanvas` or empty/first-run surface). */
    canvas: ReactNode;
    /** Optional node or item inspector (`SidePaneSpec` in `PaneGrid`, or docked `<aside>`). */
    inspector?: SidePaneSpec | ReactNode | false | null;
    /** Accessible label for the docked `<aside>` when `inspector` is a plain `ReactNode`. */
    inspectorLabel?: string;
  };
