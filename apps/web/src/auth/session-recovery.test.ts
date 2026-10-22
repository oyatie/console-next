// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { sessionRecovery } from "./session-recovery";

test.each([
  ["session_expired", "idle.reauth.expired", true],
  ["session_idle_expired", "idle.reauth.idle", true],
  ["session_revoked", "idle.reauth.admin", true],
  ["session_passkey_reset", "idle.reauth.reset", false],
  ["session_deactivated", "idle.reauth.deactivated", false],
  ["session_signed_out_elsewhere", "idle.reauth.elsewhere", true],
  [null, "idle.reauth.body", true],
])("%s names its reason and offers only usable sign-in actions", (reason, message, passkey) => {
  expect(sessionRecovery(reason as string | null)).toEqual({ message, passkey });
});
