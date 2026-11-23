// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const recordOptionalRegions = ["facts"] as const;

/**
 * Record (`P3`) page contract: arranges a structured single-entity record with `PageHead`, optional route `tabs`,
 * optional sticky `secNav` (`SecNav`), optional compact `strip`, ordered `sections` (`RecordSection` 1..N), and an
 * optional sticky `spine` (`Spine`) timeline `<aside>`.
 * `PatternShell` owns `<main>`/`<div>` landmarking, single `<h1>`, `PageReadGate`, and `QueryState`; `overlays` stay
 * mounted across loading/failure and strip on `403` refusal while keeping `<h1>` and `tabs`.
 */
export type RecordProps = PatternBaseProps & {
  /** Optional sticky section jump bar (`SecNav` + legend) beneath the head. */
  secNav?: ReactNode;
  /** Optional compact top summary strip inside the main record column. */
  strip?: ReactNode;
  /** Ordered record sections (`RecordSection` list or active sub-tab body). */
  sections: ReactNode;
  /** Optional right-hand sticky timeline/history spine (`Spine`). */
  spine?: ReactNode;
};
