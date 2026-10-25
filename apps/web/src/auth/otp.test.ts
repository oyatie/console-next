import { afterEach, expect, test } from "vitest";
import { i18n, t } from "@console/i18n";
import { normalizeOtp, OTP_LENGTH } from "./Login";

afterEach(() => i18n.set("ko"));

test("new codes fold case and grouping while legacy codes keep exact bytes", () => {
  expect(normalizeOtp(" abcde-fghjk\n")).toBe("ABCDE-FGHJK");
  expect(normalizeOtp(" aB3$-x_Z\n")).toBe("aB3$-x_Z");
  expect(normalizeOtp("abc")).toHaveLength(3);
  expect(normalizeOtp("x".repeat(20)).replaceAll("-", "")).toHaveLength(OTP_LENGTH);
});

test("the code hint uses the generated issuance length in both locales", () => {
  expect(t("auth.login.codeHint", { count: 3, length: OTP_LENGTH })).toContain(`3/${OTP_LENGTH}자`);
  i18n.set("en");
  expect(t("auth.login.codeHint", { count: 3, length: OTP_LENGTH })).toContain(`${OTP_LENGTH} characters`);
});
