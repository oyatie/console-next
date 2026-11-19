// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { getRouteApi } from "@tanstack/react-router";
import WorklistExample from "../ui/patterns/worklist.fixture";

const route = getRouteApi("/app/_review/patterns/worklist");

export function WorklistReview() {
  const { state } = route.useSearch();
  return (
    <WorklistExample
      q={
        state === "refused"
          ? {
              isPending: false,
              error: new ApiError(403, "access_denied", "", [], "worklist-refusal"),
              data: undefined,
              refetch() {},
            }
          : undefined
      }
    />
  );
}
