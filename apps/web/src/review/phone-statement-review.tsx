// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import PhoneStatementExample from "../ui/patterns/phone-statement.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/phone-statement");

export function PhoneStatementReview() {
  const { state } = route.useSearch();
  return <PhoneStatementExample q={reviewReadState(state, "phone-statement-refusal")} />;
}
