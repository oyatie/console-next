import { afterEach, expect, test } from "vitest";
import { i18n, t } from "@console/i18n";
import { normalizeOtp, OTP_LENGTH } from "./Login";

afterEach(() => i18n.set("ko"));

test("a pasted code keeps its case and symbols, loses whitespace, and stops at the code length", () => {
  expect(normalizeOtp(" aB3$-x_Z\n")).toBe("aB3$-x_Z");
  expect(normalizeOtp("Il0O Il0O extra")).toBe("Il0OIl0O");
  expect(normalizeOtp("abc")).toHaveLength(3);
  expect(normalizeOtp("x".repeat(20))).toHaveLength(OTP_LENGTH);
});

test("the code hint counts typed characters in both locales", () => {
  expect(t("auth.login.codeHint", { count: 3, length: OTP_LENGTH })).toContain("3/8자");
  i18n.set("en");
  expect(t("auth.login.codeHint", { count: 3, length: OTP_LENGTH })).toBe("8 characters · case-sensitive · 3 of 8 entered");
});
