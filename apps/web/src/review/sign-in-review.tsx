// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import SignInExample from "../ui/patterns/sign-in.fixture";

const route = getRouteApi("/_review/patterns/sign-in");

export function SignInReview() {
  const { state } = route.useSearch();
  return <SignInExample state={state} />;
}
