// Work uses action-inbox; the greeting shares the ordinary identity query.
import { api, unwrap } from "@console/api";
import { get } from "../../lib/query";
export const meQuery = get("/api/v1/users/me");
/** Confirms one of my own reference notices: it is read. */
export const markNoticeRead = (id: string) => unwrap(api.POST("/api/v1/me/action-inbox/reference/{id}/read", { params: { path: { id } } }));
/** One of my inbox items' activity: who did what and when, newest first. */
export const itemActivityQuery = (id: string) => get("/api/v1/me/action-inbox/items/{id}/activity", { params: { path: { id } } });
