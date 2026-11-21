// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const wizardOptionalRegions = ["facts"] as const;

/**
 * Wizard (`P8`) page contract: arranges a multi-step guided workflow with a step indicator strip, primary step `body`,
 * optional reference `aside` (e.g. certificate original or checklist), `ActionBar` (`notice`, `consequence`, `actions`),
 * and `overlays`.
 */
export type WizardPatternProps = PatternBaseProps & {
  /** Optional step indicator bar (e.g. `StepLine`) placed beneath `PageHead`. */
  steps?: ReactNode;
  /** Primary step content (step sections, forms, or review summary). */
  body: ReactNode;
  /** Optional reference pane beside `body` (e.g. original document or verification checklist). */
  aside?: ReactNode;
  /** Accessible label for the `aside` complementary landmark when `aside` is provided. */
  asideLabel?: string;
  /** Optional consequence summary rendered inside `ActionBar`. */
  consequence?: ReactNode;
  /** Optional validation or submission notice rendered inside `ActionBar`. */
  notice?: ReactNode;
  /** Primary progression and back/save actions rendered inside `ActionBar`. */
  actions: ReactNode;
  /** Pin `ActionBar` to the bottom of the scroll viewport (`true` by default). */
  stickyActions?: boolean;
};
