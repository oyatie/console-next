// SPDX-License-Identifier: LicenseRef-Proprietary
const states = {
  "save-500": "Fail the name PATCH with a referenced 500; the profile re-read retains the stored name.",
  "save-403": "Refuse the name PATCH; keep the dialog and allow a corrected submission.",
  "save-network": "Abort the name PATCH and its profile re-read; keep the uncertain outcome in place.",
  "save-unchanged": "Submit the stored name with surrounding whitespace; close without a command or success announcement.",
} as const;
export const accountScreens = [
  { key: "account", path: "/account", read: "/api/v1/users/me", states, registry: "account--profile-name", live: "e2e/account.spec.ts" },
] as const;
export type AccountState = keyof typeof states;
