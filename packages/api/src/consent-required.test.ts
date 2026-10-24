// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, api, authFetch, configure, session, unwrap } from "./index";
import { authPost } from "./session";

const pair = {
  access_token: `h.${btoa(JSON.stringify({ sub: "user", org: "tenant" }))}.s`,
  token_type: "Bearer" as const, refresh_expires_at: "2027-01-01T00:00:00Z",
  requires_passkey_setup: false, privacy_consent_accepted: true,
};
afterEach(() => { session.set(null); vi.unstubAllGlobals(); });

test.each(["fetch", "openapi", "auth"])("%s transport immediately marks a typed consent refusal without refreshing or replaying", async (transport) => {
  configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
  session.set(pair);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "privacy_consent_required", message: "Review documents" } }), { status: 403, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  if (transport === "fetch") expect((await authFetch(new Request("https://console.example/api/v1/employees"))).status).toBe(403);
  else await expect(transport === "auth" ? authPost("/api/v1/auth/passkeys", undefined, true) : unwrap(api.GET("/api/v1/employees"))).rejects.toMatchObject({ status: 403, code: "privacy_consent_required" });
  expect(session.consentAccepted).toBe(false);
  expect(session.token).toBe(pair.access_token);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([[403, "forbidden"], [409, "privacy_consent_required"]])("%s %s never changes consent", (status, code) => {
  session.set(pair);
  ApiError.fromBody(new Response(null, { status }), { error: { code, message: "Refused" } });
  expect(session.consentAccepted).toBe(true);
});

test.each(["fetch", "auth"])("a late %s consent refusal cannot interrupt a replacement account", async (transport) => {
  configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
  session.set(pair);
  let deliver!: (response: Response) => void;
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { deliver = resolve; }));
  const pending = transport === "fetch" ? authFetch(new Request("https://console.example/api/v1/employees")) : authPost("/api/v1/auth/passkeys", undefined, true).catch((e: unknown) => e);
  session.set({ ...pair, access_token: `h.${btoa(JSON.stringify({ sub: "other", org: "tenant" }))}.s` });
  deliver(new Response(JSON.stringify({ error: { code: "privacy_consent_required", message: "Review documents" } }), { status: 403 }));
  const response = await pending;
  if (response instanceof Response) await ApiError.from(response);
  expect(session.consentAccepted).toBe(true);
});
