// SPDX-License-Identifier: LicenseRef-Proprietary
type CardRole = "title" | "status" | "fact" | "action" | "omit";
/** A list opts into narrow cards by declaring a card role; editing grids keep every control. */
export type CardColumn = { card?: CardRole; rowHeader?: boolean; wide?: boolean };
const KEY_FACTS = 3;

/** Existing row headers identify a card; secondary columns stay available in its record. */
export function cardRoles(columns: readonly CardColumn[]): CardRole[] {
  let facts = 0;
  return columns.map((column, index) => {
    const role = column.card ?? (column.rowHeader || index === 0 ? "title" : column.wide ? "omit" : "fact");
    return role === "fact" && ++facts > KEY_FACTS ? "omit" : role;
  });
}
