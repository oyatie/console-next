// SPDX-License-Identifier: LicenseRef-Proprietary
/** Shared viewport thresholds, consumed by CSS at build time and by browser layout checks. */
export const breakpoints = { sm: 640, md: 768, lg: 960, xl: 1280 } as const;

export const mediaQueries = {
  small: `(width <= ${breakpoints.sm}px)`,
  phone: `(width < ${breakpoints.md}px)`,
  tablet: `(width >= ${breakpoints.md}px)`,
  "below-wide": `(width < ${breakpoints.xl}px)`,
};
