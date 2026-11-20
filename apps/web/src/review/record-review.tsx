// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import RecordExample from "../ui/patterns/record.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/record");

export function RecordReview() {
  const { state } = route.useSearch();
  return <RecordExample q={reviewReadState(state, "record-refusal")} />;
}
