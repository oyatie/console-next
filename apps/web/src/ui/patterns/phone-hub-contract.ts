// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import type { PatternBaseProps } from "./pattern-shell";

/** Only redundant summary facts may be omitted by an arrangement. */
export const phoneHubOptionalRegions = ["facts"] as const;

/** A full-width rule-divided quick-navigation row rendered inside `PhoneHub`. */
export type PhoneHubLinkItem = {
  key: string;
  icon?: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  href?: string;
  onPress?: () => void;
};

/** A grouped fact or action section inside `PhoneHub` with a `--surface-2` header bar. */
export type PhoneHubSection = {
  key: string;
  title: ReactNode;
  titleId?: string;
  action?: ReactNode;
  children: ReactNode;
};

/**
 * PhoneHub (`P12`) page contract: arranges a phone-first single-column self-service hub with a
 * `PagePhoneHeader`-aware head, `identity` header band, top `stats` `StatRow`, rule-divided `links`, and
 * grouped `sections`.
 */
export type PhoneHubProps = PatternBaseProps & {
  /** Identity header band (person name, employment status chip, role subtitle). */
  identity?: ReactNode;
  /** Flush summary `StatRow` directly beneath `identity`. */
  stats?: ReactNode;
  /** Quick-navigation destination rows above grouped sections. */
  links?: readonly PhoneHubLinkItem[];
  /** Optional custom link renderer for router integration without importing router inside `ui/`. */
  renderLink?: (item: PhoneHubLinkItem, content: ReactNode, className: string) => ReactNode;
  /** Grouped fact/action/log sections. */
  sections: readonly PhoneHubSection[];
};
