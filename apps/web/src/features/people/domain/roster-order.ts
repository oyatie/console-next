// SPDX-License-Identifier: LicenseRef-Proprietary
import { listQuery, parseSort, type RosterFilter, type RosterSort } from "./roster";

export type RosterOrder = RosterSort | `-${RosterSort}`;
export type OrderedRoster = Omit<RosterFilter, "sort"> & { sort?: RosterOrder };
export function parseOrder(raw?: string): RosterOrder {
  const key = parseSort(raw?.replace(/^-/, ""));
  return raw === `-${key}` ? `-${key}` : key;
}

/** An explicit order selects the server's keyset contract, including the default name order. */
export const orderedQuery = (filter: OrderedRoster, today: string, soonDays: number) => ({
  ...listQuery({ ...filter, sort: undefined }, today, soonDays),
  sort: filter.sort ?? "name",
});
