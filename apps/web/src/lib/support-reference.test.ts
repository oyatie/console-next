// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ApiError, configure, session } from "@console/api";
import { loadCatalog } from "@console/i18n";
beforeAll(() => loadCatalog("ko"));
import { resolveSupportReference, supportReferenceFromError } from "./support-reference";
import { failureText } from "./refusal";

const ref = "019a0000-0000-7000-8000-000000000001";

test("only the server-issued reference reaches a mutation refusal", () => {
  const error = ApiError.fromBody(new Response(null, { status: 500 }), { error: { code: "internal", message: "internal server error", support_ref: ref } });
  expect(supportReferenceFromError(error)).toBe(ref);
  expect(failureText(error)).not.toContain(ref);
  expect(failureText(error)).not.toContain("secret-input");
});

test("network and render errors have no fabricated support reference or trace", () => {
  expect(supportReferenceFromError(new TypeError("offline"))).toBeUndefined();
  expect(supportReferenceFromError(new Error("render failed"))).toBeUndefined();
});

test.each([
  ["support_reference_cross_tenant_denied", "다른 고객 계정의 지원 참조 번호는 조회할 수 없습니다."],
  ["support_reference_grant_required", "지원 참조 번호를 조회할 권한이 없습니다. 관리자에게 권한을 요청하십시오."],
])("%s uses catalog recovery copy and the server's reference", (code, copy) => {
  const error = ApiError.fromBody(new Response(null, { status: 403 }), { error: { code, message: "unlocalized diagnostic", support_ref: ref } });
  expect(failureText(error)).toContain(copy);
  expect(failureText(error)).not.toContain(ref);
});


afterEach(() => { vi.unstubAllGlobals(); session.set(null); });
test.each([false, true])("support lookup chooses the session's tier (%s)", async platform => {
  session.set({ access_token: `header.${btoa(JSON.stringify({ platform }))}.signature`, token_type: "Bearer", requires_passkey_setup: false, refresh_expires_at: "2027-01-01T00:00:00Z" });
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string) => {
    calls.push(new Request(input).url);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  await resolveSupportReference(` ref ${ref} `);
  expect(calls).toEqual([`https://console.example/api/${platform ? "platform" : "v1"}/support-references/${ref}`]);
});
