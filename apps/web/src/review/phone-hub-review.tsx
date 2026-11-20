// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import PhoneHubExample from "../ui/patterns/phone-hub.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/phone-hub");

export function PhoneHubReview() {
  const { state } = route.useSearch();
  return <PhoneHubExample q={reviewReadState(state, "phone-hub-refusal")} />;
}
