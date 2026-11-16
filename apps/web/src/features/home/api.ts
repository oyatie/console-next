// Work uses action-inbox; the greeting shares the ordinary identity query.
import { api, unwrap } from "@console/api";
import { get } from "../../lib/query";
export const meQuery = get("/api/v1/users/me");
/** Confirms one of my own reference notices: it is read. */
export const markNoticeRead = (id: string) => unwrap(api.POST("/api/v1/me/action-inbox/reference/{id}/read", { params: { path: { id } } }));
/** One of my inbox items' activity: who did what and when, newest first. */
export const itemActivityQuery = (id: string) => get("/api/v1/me/action-inbox/items/{id}/activity", { params: { path: { id } } });
/** Postpones one of my inbox items to a day; postponing it again moves the day. */
export const snoozeItem = (id: string, until: string) => unwrap(api.POST("/api/v1/me/action-inbox/items/{id}/snooze", { params: { path: { id } }, body: { until } }));
/** Brings a postponed item back to my list now. */
export const unsnoozeItem = (id: string) => unwrap(api.DELETE("/api/v1/me/action-inbox/items/{id}/snooze", { params: { path: { id } } }));
