// SPDX-License-Identifier: LicenseRef-Proprietary
/** The structure acts `?act=` names on the selection `sel` of the company structure page (routes/org.ts validates them). */
export const STRUCTURE_ACTS = ["wp-create", "wp-primary", "wp-delete", "wp-close", "wp-kind", "wp-kinds", "wp-head", "dept-add", "dept-rename", "dept-head", "dept-delete", "dept-merge", "dept-dissolve"] as const;
export type StructureAct = (typeof STRUCTURE_ACTS)[number];
