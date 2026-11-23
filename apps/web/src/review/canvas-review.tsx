// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import CanvasExample from "../ui/patterns/canvas.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/canvas");

export function CanvasReview() {
  const { state } = route.useSearch();
  return <CanvasExample q={reviewReadState(state, "canvas-refusal")} />;
}
