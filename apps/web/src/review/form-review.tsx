// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import FormExample from "../ui/patterns/form.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/form");

export function FormReview() {
  const { state } = route.useSearch();
  return <FormExample q={reviewReadState(state, "form-refusal")} />;
}
