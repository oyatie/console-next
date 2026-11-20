// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import DocumentDecisionExample from "../ui/patterns/document-decision.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/document-decision");

export function DocumentDecisionReview() {
  const { state } = route.useSearch();
  return <DocumentDecisionExample q={reviewReadState(state, "document-decision-refusal")} />;
}
