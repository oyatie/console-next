// SPDX-License-Identifier: LicenseRef-Proprietary
export const ORG_TABS = ["chart", "entities", "changes"] as const;

/** The chart is the default, including unknown or malformed bookmarks. */
export const orgTab = (value: unknown) => value === ORG_TABS[1] || value === ORG_TABS[2] ? value : undefined;
