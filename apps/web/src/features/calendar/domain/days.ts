// SPDX-License-Identifier: LicenseRef-Proprietary
import { todayKst } from "../../../lib/pure/today";
import { addDays } from "../../../ui/date/days";

export const dayOfEvent = (timestamp: string) => todayKst(new Date(timestamp));

/** Bucket each interval once and visit only the visible days it actually covers. */
export function eventsOnDays<T extends { starts_at: string; ends_at: string }>(days: readonly string[], events: readonly T[]) {
  const result = new Map<string,T[]>(days.map(day => [day, []]));
  const first = days[0], last = days.at(-1);
  if (!first || !last) return result;
  for (const event of events) {
    const start = Date.parse(event.starts_at), end = Date.parse(event.ends_at);
    const from = todayKst(new Date(start));
    // End dates are exclusive for an interval. A zero-duration appointment belongs to its start day.
    const through = todayKst(new Date(end > start ? end - 1 : start));
    for (let day = from < first ? first : from; day <= through && day <= last; day = addDays(day,1)) {
      result.get(day)?.push(event);
    }
  }
  return result;
}
