// SPDX-License-Identifier: LicenseRef-Proprietary
/** The server uses (sort value, id) as its unique key; a sort value alone can skip equal names. */
export type KeysetCursor = { value: string | number | null; id: string };

/**
 * Request pages with cursor + limit and the same server sort/filter.
 * The server applies Cedar before counting, assigning positions, or making cursors; hidden rows
 * contribute to none of them. row_index is one-based within that authorized, filtered result.
 * null means the server cannot supply a total, never the size of the loaded page.
 */
export type ListPage<R> = {
  items: (R & { row_index: number })[];
  total: number | null;
  next_cursor: KeysetCursor | null;
};
