// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import type { PaneGrid } from "../pane-grid/pane-grid";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const settingsOptionalRegions = ["facts"] as const;

/**
 * Settings (`P9`) page contract: arranges a settings workspace with an optional `views` navigation rail in
 * `PaneGrid` `start`, an optional `summary` band, a primary `panel` in `PaneGrid` `main`, and an optional
 * `record`/`related` side pane.
 */
export type SettingsPatternProps = PatternBaseProps &
  Pick<ComponentProps<typeof PaneGrid>, "record" | "related" | "full" | "onFull" | "onSelect" | "onOpen"> & {
    /** Optional settings navigation/category list rendered in `PaneGrid` `start`. */
    views?: ReactNode;
    /** Optional top governance or scope summary band above `PaneGrid`. */
    summary?: ReactNode;
    /** Required primary settings panel/sections or hub view inside `PaneGrid` `main`. */
    panel: ReactNode;
  };
