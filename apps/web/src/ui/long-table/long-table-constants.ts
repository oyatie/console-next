// SPDX-License-Identifier: LicenseRef-Proprietary
export const SELECT = "__select";
// React Aria shares one collection key space between rows and columns.
export const rowKey = (id: string) => `row:${id}`;
export const rowId = (key: string | number) => String(key).slice("row:".length);
// The first layout uses these pixel estimates until the mounted CSS supplies its actual sizes.
export const LAYOUT = {
  regular: { estimatedRowHeight: 40, headingHeight: 40, loaderHeight: 40 },
  compact: { estimatedRowHeight: 32, headingHeight: 36, loaderHeight: 32 },
};

export const SELECT_WIDTH = 48;
/** Placeholder rows while the first page loads (long-table.module.css sizes the table to fit them). */
export const SKELETON_ROWS = 8;
