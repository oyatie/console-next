// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { getRouteApi } from "@tanstack/react-router";
import ListRecordExample from "../ui/patterns/list-record.fixture";

const route = getRouteApi("/app/_review/patterns/list-record");
export function ListRecordReview() {
  const { state } = route.useSearch();
  return <ListRecordExample q={state === "refused" ? {
    isPending: false, error: new ApiError(403, "access_denied", "", [], "pattern-refusal"), data: undefined, refetch() {},
  } : undefined} />;
}
