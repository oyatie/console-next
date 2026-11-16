// SPDX-License-Identifier: LicenseRef-Proprietary
const states = {
  loading: "Hold the consent read or the explicit one-time-code sign-in until released.",
  refused: "Return 409 terms_not_published for consent documents, or reject the one-time code with 401.",
} as const;
export const accountSecurityScreens = [
  { key: "login", path: "/login", read: "/api/v1/auth/otp/redeem", states },
  { key: "setup-passkey", path: "/setup-passkey", read: "/api/v1/onboarding/terms", states },
] as const;
export type AccountSecurityScreen = (typeof accountSecurityScreens)[number];
export type AccountSecurityState = keyof typeof states;
