// SPDX-License-Identifier: LicenseRef-Proprietary
import { addDays, utc } from "./days";

/**
 * The month as Sunday-first weeks (A2 calendar): each week holds 7 dates, including the neighbouring months' days that
 * fill the first and last week, so the grid keeps its shape.
 */
export function monthWeeks(month: string): string[][] {
  let d = addDays(`${month}-01`, -new Date(utc(`${month}-01`)).getUTCDay());
  const weeks: string[][] = [];
  do {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
    d = addDays(d, 7);
  } while (d.slice(0, 7) === month);
  return weeks;
}
