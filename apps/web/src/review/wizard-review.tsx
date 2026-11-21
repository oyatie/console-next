// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import WizardExample from "../ui/patterns/wizard.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/wizard");

export function WizardReview() {
  const { state } = route.useSearch();
  return <WizardExample q={reviewReadState(state, "wizard-refusal")} />;
}
