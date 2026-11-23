// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import MonthGridExample from "../ui/patterns/month-grid.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/month-grid");

export function MonthGridReview() {
  const { state } = route.useSearch();
  return <MonthGridExample q={reviewReadState(state, "month-grid-refusal")} />;
}
