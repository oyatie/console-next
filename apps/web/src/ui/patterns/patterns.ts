// SPDX-License-Identifier: LicenseRef-Proprietary
export const PATTERNS = ["worklist", "list-record", "record", "document-decision", "month-grid", "register-totals", "form", "wizard", "settings", "canvas", "sign-in", "phone-hub", "phone-statement"] as const;
export type PatternId = (typeof PATTERNS)[number];
/** A route may name only a pattern that has its component here. */
export const BUILT_PATTERNS = ["list-record"] as const satisfies readonly PatternId[];
