// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";

type CardRole = "title" | "status" | "fact" | "action" | "omit";
/** Narrow cards infer title/facts; explicit roles preserve stronger hierarchy or omit secondary detail. */
export type CardColumn = { card?: CardRole; cardHeader?: ReactNode; rowHeader?: boolean; wide?: boolean };

/** Existing row headers identify a card; callers explicitly mark secondary columns they omit. */
export function cardRoles(columns: readonly CardColumn[]): CardRole[] {
  return columns.map((column, index) => {
    const role = column.card ?? (column.rowHeader || index === 0 ? "title" : column.wide ? "omit" : "fact");
    return role;
  });
}
