// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components } from "@console/api";
import { cursorRead } from "../../lib/query";
import { addDays } from "../../ui/date/days";

export type CalendarEvent = components["schemas"]["CalendarEventResponse"];
export type NewEvent = components["schemas"]["CreateCalendarEventRequest"];
export const eventsPath = "/api/v1/collaboration/calendar/events";
export const eventPages = (first: string, last: string) => {
  const range = { from: `${first}T00:00:00+09:00`, to: `${addDays(last, 1)}T00:00:00+09:00`, limit: 100 };
  return cursorRead(eventsPath, range, cursor => unwrap(api.GET(eventsPath, { params: { query: { ...range, cursor } } })));
};
export const createEvent = (body: NewEvent, key: string) => unwrap(api.POST(eventsPath, { body, headers: { "Idempotency-Key": key } }));
