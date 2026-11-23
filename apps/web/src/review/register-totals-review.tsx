// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import RegisterTotalsExample from "../ui/patterns/register-totals.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/register-totals");

export function RegisterTotalsReview() {
  const { state } = route.useSearch();
  return <RegisterTotalsExample q={reviewReadState(state, "register-totals-refusal")} />;
}
