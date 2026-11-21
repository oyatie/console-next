// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import SettingsExample from "../ui/patterns/settings.fixture";
import { reviewReadState } from "./review-state";

const route = getRouteApi("/app/_review/patterns/settings");

export function SettingsReview() {
  const { state } = route.useSearch();
  return <SettingsExample q={reviewReadState(state, "settings-refusal")} />;
}
