import { expect, test } from "vitest";
import { t } from "@console/i18n";
import { ApiError } from "@console/api";
import { failureText, signInError } from "./refusal";

test("a browser too old for passkeys gets the update message, never the network message", () => {
  expect(signInError(new Error("passkey_unavailable"))).toBe(t("auth.passkey.unavailable"));
  expect(signInError(new Error("passkey_unavailable"))).not.toBe(t("common.networkError"));
});

test("a dismissed prompt is no error; a fetch fault is the network message; any other refusal is the passkey message", () => {
  expect(signInError(new Error("passkey_cancelled"))).toBeNull();
  expect(signInError(new TypeError("Failed to fetch"))).toBe(t("common.networkError"));
  expect(signInError(new DOMException("x", "SecurityError"))).toBe(t("auth.passkey.failed"));
});

test("a known error code reads from the catalog before the server's message; an unknown one keeps the server's", () => {
  expect(failureText(new ApiError(409, "stale_revision", "요청을 처리하지 못했습니다."))).toBe(t("common.failed.code.stale_revision"));
  expect(failureText(new ApiError(409, "something_else", "서버 문구"))).toBe("서버 문구");
});

// TS-28: a shed or rate-limited command said only "failed"; it now says when to try again (it is never auto-retried).
test("a 503 or 429 with Retry-After says when to try again; other refusals do not", () => {
  const shed = new ApiError(503, "unavailable", "서버 문구", [], undefined, true, [], { retryAfterMs: 1500 });
  expect(failureText(shed)).toBe(`서버 문구 ${t("common.failed.retryAfter", { seconds: "2" })}`);
  const limited = new ApiError(429, "rate_limited", "제한", [], undefined, true, [], { retryAfterMs: 60_000 });
  expect(failureText(limited)).toContain(t("common.failed.retryAfter", { seconds: "60" }));
  expect(failureText(new ApiError(409, "something_else", "서버 문구", [], undefined, true, [], { retryAfterMs: 5000 }))).toBe("서버 문구");
  expect(failureText(new ApiError(503, "unavailable", "서버 문구"))).toBe("서버 문구");
});
