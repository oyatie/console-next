// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import type { ReadState } from "../lib/react/query-view";

/** Returns a `403` refusal `ReadState` when `?state=refused` is active on a pattern review route. */
export function reviewReadState(state: "refused" | undefined, ref: string): ReadState | undefined {
  return state === "refused"
    ? {
        isPending: false,
        error: new ApiError(403, "access_denied", "", [], ref),
        data: undefined,
        refetch() {},
      }
    : undefined;
}
