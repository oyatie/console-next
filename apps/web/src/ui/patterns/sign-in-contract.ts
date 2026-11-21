// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";

/** Only redundant summary facts may be omitted by an arrangement. */
export const signInOptionalRegions = ["facts"] as const;

/**
 * SignIn (`P11`) page contract: standalone authentication / passkey-setup arrangement rendered outside the signed-in
 * shell (`getParentRoute: () => root`). Uses no `PatternShell`, `PageReadGate`, `QueryState`, or screen catalogs so
 * auth routes stay within `checkSignInBudget`.
 */
export type SignInPatternProps = {
  /** Primary page heading rendered inside `PageHead` (`<h1>`). */
  title: ReactNode;
  /** Optional id attached to the `<h1>` heading for focus management. */
  titleId?: string;
  /** Optional subtle context badge or realm metadata beside the title. */
  context?: ReactNode;
  /** Marks the card `aria-busy` while a passkey or code ceremony is in flight. */
  busy?: boolean;
  /** Skeleton placeholder shown in place of controls while initial terms/config load. */
  loading?: ReactNode;
  /** Error, recovery, or session status banners above the primary body. */
  notices?: ReactNode;
  /** Primary authentication or consent-enrollment body. */
  body: ReactNode;
  /** Optional secondary sign-in method (e.g. collapsible one-time code disclosure). */
  secondary?: ReactNode;
  /** Optional trailing footer actions or cancellation links. */
  foot?: ReactNode;
  /** Optional redundant summary facts omitted by this arrangement (`signInOptionalRegions`). */
  facts?: ReactNode;
  /** Optional modal or sheet overlays mounted inside the standalone landmark. */
  overlays?: ReactNode;
  /** Temporary Classic (`baseline`) fallback renderer kept until Phase 7. */
  baseline?: () => ReactNode;
};
