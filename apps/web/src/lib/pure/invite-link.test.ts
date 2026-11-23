// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { buildInviteUrl } from "./invite-link";

test("buildInviteUrl keeps the one-time secret in the #otp fragment without query params", () => {
  expect(buildInviteUrl("https://console.example.test/", " ABCDE-FGHJK ")).toBe(
    "https://console.example.test/login#otp=ABCDE-FGHJK",
  );
  expect(buildInviteUrl("https://console.example.test", "cop_AbC-123_xyz")).toBe(
    "https://console.example.test/login#otp=cop_AbC-123_xyz",
  );
  expect(buildInviteUrl("https://console.example.test", "cop_AbC")).not.toContain("?otp=");
});
