// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const formOptionalRegions = ["facts"] as const;

/**
 * Form (`P7`) page contract: arranges a governed full-page or phone submission form with a `PagePhoneHeader`-aware
 * `head`, optional top `summary` band (e.g. balance `StatRow` and segmented `Meter`), ruled form `sections`,
 * sticky or inline `ActionBar` (`consequence`, `notice`, `actions`), and optional `overlays`.
 */
export type FormPatternProps = PatternBaseProps & {
  /** Optional top summary band above the form (e.g. leave balance `StatRow` + segmented `Meter`). */
  summary?: ReactNode;
  /** Primary form sections (`FieldSet`s, `Field`s, `DateField`s, context rows). */
  sections: ReactNode;
  /** Optional server or validation notice rendered inside `ActionBar`. */
  notice?: ReactNode;
  /** Optional numeric or state consequence rendered above `actions` inside `ActionBar`. */
  consequence?: ReactNode;
  /** Primary submit and secondary cancel controls rendered inside `ActionBar`. */
  actions: ReactNode;
  /** Submitter callback forwarded to `Form` (`submitter` button `value`, or `null`). */
  onSubmit: (submitter: string | null) => void;
  /** Optional HTML form id. */
  formId?: string;
  /** Disable native validation summary when the caller handles custom validation. */
  noValidate?: boolean;
  /** Pin `ActionBar` to the bottom of the scroll viewport (`true` by default). */
  stickyActions?: boolean;
};
