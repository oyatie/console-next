// SPDX-License-Identifier: LicenseRef-Proprietary
export const TABS = ["overview", "certificates", "workplaces", "officers", "documents", "history"] as const;
export type Tab = (typeof TABS)[number];
