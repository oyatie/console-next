// SPDX-License-Identifier: LicenseRef-Proprietary
// Login has no route read: loading, failed and empty are n/a; command waits are pending.
// Consent documents are required singleton records: empty is n/a.
export const accountSecurityScreens = [
  { key: "login", path: "/login", read: "/api/v1/auth/otp/redeem", states: {
    pending: "Hold the one-time-code sign-in until released.",
    refused: "Reject a well-formed one-time code with 401.",
  } },
  { key: "setup-passkey", path: "/setup-passkey", read: "/api/v1/onboarding/terms", states: {
    loading: "Hold the consent document read until released.",
    failed: "Return 409 terms_not_published for consent documents.",
    refused: "A signed-out visitor returns to sign-in.",
  } },
] as const;
export type AccountSecurityScreen = (typeof accountSecurityScreens)[number];
export type AccountSecurityState = "pending" | "refused" | "loading" | "failed";
