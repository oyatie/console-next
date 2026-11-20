// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import type { PaneGrid } from "../pane-grid/pane-grid";
import type { SidePaneSpec } from "../pane-grid/pane-grid-side";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const documentDecisionOptionalRegions = ["facts"] as const;

/**
 * DocumentDecision (`P4`) page contract: arranges an approval or review document in a two- or three-pane workspace
 * (`start` metadata/chain/queue rail, center `document` canvas, and right-hand `decision` pane as either a docked
 * `<aside>` or a dismissible `SidePaneSpec`).
 */
export type DocumentDecisionProps = PatternBaseProps &
  Pick<ComponentProps<typeof PaneGrid>, "related" | "full" | "onFull" | "onSelect" | "onOpen"> & {
    /** Optional inline-start pane (`PaneGrid` `start`): document facts, `ChainStepper`, attachments, or inbox queue. */
    start?: ReactNode;
    /** Primary document canvas (`PaneGrid` `main`): heading, meta, diff/changes, reason, and impact sections. */
    document: ReactNode;
    /** Optional right-hand decision pane: pass a `SidePaneSpec` for dismissible split-inbox mode or a `ReactNode` for a docked `<aside>`. */
    decision?: SidePaneSpec | ReactNode | false | null;
    /** Accessible `<aside>` label when `decision` is passed as a docked `ReactNode`. */
    decisionLabel?: string;
  };
