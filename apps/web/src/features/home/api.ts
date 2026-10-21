// Home's reads: the viewer, and how each read the queue is built from went (lib/react/query-defaults never
// re-asks a refused one on its own).
import { ApiError } from "@console/api";
import { get } from "../../lib/query";
import { EXIT_FEATURES, type Feature } from "../../reference/authz/api";
import type { ReadState } from "./domain/coverage";

export const meQuery = get("/api/v1/users/me");

/** A read as one part of the queue: still arriving, landed, refused (403: this account may not read it) or failed. */
export const readState = (q: { isPending: boolean; isError: boolean; data: unknown; error: unknown }): ReadState => {
  if (q.isPending) return "loading";
  if (!q.isError || q.data !== undefined) return "ok";
  return q.error instanceof ApiError && q.error.status === 403 ? "denied" : "failed";
};

/**
 * Everything this app lets someone do (reference/authz `Feature`). An account holding none of them has no work here;
 * capabilities of other products (or request-only ones) do not count.
 */
export const WORK_FEATURES = [
  "org_change_read", "org_change_draft", "org_change_approve", "org_change_apply", "employee_directory_read", "employee_directory_manage",
  "user_manage", "period_lock_manage", ...EXIT_FEATURES, "excel_download", "job_title_manage",
] as const satisfies readonly Feature[];

/** Whether an account can do anything this app offers (`can`: reference/authz `granted`). */
export const hasWork = (can: (f: Feature) => boolean) => WORK_FEATURES.some((f) => can(f));
