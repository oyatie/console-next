import { afterEach, expect, test, vi } from "vitest";
import { api, ApiError, configure, retryAfterMs, session, unwrap, type Platform } from "./index";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const passkeys: Platform["passkeys"] = { get: async () => null, create: async () => null };
afterEach(() => {
  vi.unstubAllGlobals();
  session.set(null);
});

test("native: a 401 refreshes once with the stored token, persists the rotation, then retries", async () => {
  let stored: string | null = "rt-1";
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "body", load: async () => stored, save: async (t) => void (stored = t) } });
  session.set({ access_token: "expired", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`);
    if (req.url.endsWith("/api/v1/auth/token/refresh")) {
      expect(await req.json()).toEqual({ refresh_token: "rt-1" });
      expect(req.headers.get("x-auth-transport")).toBeNull();
      return json(200, { access_token: "fresh", refresh_token: "rt-2", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
    }
    return req.headers.get("authorization") === "Bearer fresh" ? json(200, { id: "u1" }) : json(401, { error: { code: "unauthorized", message: "expired" } });
  });

  const me = await unwrap(api.GET("/api/v1/users/me"));
  expect(me).toEqual({ id: "u1" });
  expect(stored).toBe("rt-2");
  expect(calls).toEqual([
    "GET https://console.example/api/v1/users/me Bearer expired",
    "POST https://console.example/api/v1/auth/token/refresh ",
    "GET https://console.example/api/v1/users/me Bearer fresh",
  ]);
});

test("a failed refresh ends the session and surfaces the backend error envelope", async () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "body", load: async () => "rt", save: async () => {} } });
  session.set({ access_token: "expired", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  vi.stubGlobal("fetch", async () => json(401, { error: { code: "unauthorized", message: "session revoked", operation_id: "op-1" } }));
  await expect(unwrap(api.GET("/api/v1/users/me"))).rejects.toMatchObject({ status: 401, code: "unauthorized", operationId: "op-1" });
  expect(session.token).toBeNull();
});

test.each(["step_up_required", "passkey_step_up_failed"])("%s reaches the caller without refresh or resending a refused command", async (code) => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "body", load: async () => "rt", save: async () => {} } });
  session.set({ access_token: "fresh", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const fetch = vi.fn(async () => json(401, { error: { code, message: "assertion required" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(unwrap(api.POST("/api/v1/auth/admin/otp/issue", { body: { user_id: "u1", step_up: { ceremony_id: "c1", credential: {} } } }))).rejects.toMatchObject({ status: 401, code });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(session.token).toBe("fresh");
});

test("bearer calls under /auth/ (admin OTP issue, consent) refresh on 401 too; sign-in calls never do", async () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "body", load: async () => "rt", save: async () => {} } });
  session.set({ access_token: "expired", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    calls.push(path);
    if (path === "/api/v1/auth/token/refresh") return json(200, { access_token: "fresh", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
    if (path === "/api/v1/auth/otp/redeem") return json(401, { error: { code: "invalid_otp", message: "bad code" } });
    return req.headers.get("authorization") === "Bearer fresh" ? json(200, { accepted: true }) : json(401, { error: { code: "unauthorized", message: "expired" } });
  });
  await unwrap(api.POST("/api/v1/auth/admin/otp/issue", { body: { user_id: "u1", step_up: { ceremony_id: "c1", credential: {} } } }));
  const { consentStatus, redeemOtp } = await import("./index");
  session.set({ access_token: "expired", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  await consentStatus();
  await expect(redeemOtp("x")).rejects.toMatchObject({ code: "invalid_otp" });
  expect(calls).toEqual([
    "/api/v1/auth/admin/otp/issue", "/api/v1/auth/token/refresh", "/api/v1/auth/admin/otp/issue",
    "/api/v1/auth/privacy-consent/status", "/api/v1/auth/token/refresh", "/api/v1/auth/privacy-consent/status",
    "/api/v1/auth/otp/redeem",
  ]);
});

test("native logout sends the stored refresh token so the server revokes its family", async () => {
  let stored: string | null = "rt-9";
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "body", load: async () => stored, save: async (t) => void (stored = t) } });
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    bodies.push(await new Request(input, init).json());
    return new Response(null, { status: 204 });
  });
  const { logout } = await import("./index");
  await logout();
  expect(bodies).toEqual([{ refresh_token: "rt-9" }]);
  expect(stored).toBeNull();
});

test("an error without the server envelope is marked, so the UI shows catalog copy instead of status text", () => {
  const e = ApiError.fromBody(new Response(null, { status: 502, statusText: "Bad Gateway" }), "<html>");
  expect(e).toMatchObject({ status: 502, fromServer: false });
});

test("list query parameters go out as one comma-separated value (the server rejects repeated keys)", async () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  let url = "";
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    url = new Request(input, init).url;
    return json(200, { items: [], total: 0, limit: 8, offset: 0 });
  });
  await unwrap(api.GET("/api/v1/employees", { params: { query: { status: ["ACTIVE", "ON_LEAVE"], limit: 8 } } }));
  expect(new URL(url).searchParams.getAll("status")).toEqual(["ACTIVE,ON_LEAVE"]);
});

test("a refused batch keeps the server's per-item refusals", () => {
  const refusals = [{ employee_id: "e1", code: "lifecycle_noop", message: "TRANSFER would not change the employee" }];
  const e = ApiError.fromBody(new Response(null, { status: 422 }), { error: { code: "bulk_lifecycle_refused", message: "refused", refusals } });
  expect(e).toMatchObject({ code: "bulk_lifecycle_refused", refusals });
});

test("session stage: a code session enrolls; a token that disagrees with the passkey state is stale", () => {
  const jwt = (claims: object) => `h.${btoa(JSON.stringify({ sub: "u1", org: "o1", roles: [], platform: false, read_only: false, ...claims })).replace(/=+$/, "")}.s`;
  const pair = (claims: object, requires_passkey_setup: boolean) => ({ access_token: jwt(claims), token_type: "Bearer" as const, refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup });
  session.set(pair({ enrollment: true }, true));
  expect(session.stage).toBe("enroll");
  session.set(pair({}, false));
  expect(session.stage).toBe("app");
  // Registration finished but the passkey sign-in never followed.
  session.set(pair({ enrollment: true }, false));
  expect(session.stage).toBe("stale");
  // Passkeys reset under a live passkey session.
  session.set(pair({}, true));
  expect(session.stage).toBe("stale");
});

test("a refusal keeps its field errors, its named facts and the server's Retry-After", () => {
  const body = { error: { code: "period_locked", message: "locked", errors: [{ field: "effective_date", code: "in_locked_period" }], details: { lock: { domain: "payroll" } } } };
  const e = ApiError.fromBody(new Response(null, { status: 409 }), body);
  expect(e).toMatchObject({ code: "period_locked", errors: [{ field: "effective_date", code: "in_locked_period" }], details: { lock: { domain: "payroll" } } });
  expect(e.retryAfterMs).toBeUndefined();
  const shed = ApiError.fromBody(new Response(null, { status: 503, headers: { "retry-after": "15" } }), { error: { code: "service_unavailable", message: "busy" } });
  expect(shed).toMatchObject({ retryAfterMs: 15_000, errors: [], details: {} });
});

test("Retry-After reads delta-seconds or an HTTP date; anything else is no hint", () => {
  const now = Date.parse("2026-10-07T00:00:00Z");
  expect(retryAfterMs("2", now)).toBe(2000);
  expect(retryAfterMs("Wed, 07 Oct 2026 00:00:05 GMT", now)).toBe(5000);
  expect(retryAfterMs("Wed, 06 Oct 2026 23:00:00 GMT", now)).toBe(0);
  expect(retryAfterMs("soon", now)).toBeUndefined();
  expect(retryAfterMs(null, now)).toBeUndefined();
});


test("a truncated command response preserves its intent key for outcome lookup", async () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  session.set({ access_token: "fresh", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  let key: string | null = null;
  vi.stubGlobal("fetch", async (req: Request) => {
    key = req.headers.get("idempotency-key");
    return new Response('{"applied":', { status: 200, headers: { "content-type": "application/json" } });
  });
  await expect(unwrap(api.POST("/api/v1/auth/admin/otp/issue", { body: { user_id: "u1", step_up: { ceremony_id: "c1", credential: {} } } }))).rejects.toMatchObject({ status: 0, code: "command_unknown", requestKey: expect.any(String) });
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
});

test.each(["step_up_required", "passkey_step_up_required", "step_up_failed", "passkey_step_up_failed", "passkey_step_up_binding_mismatch"])("%s reaches the form without refreshing or replaying the refused command", async (code) => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  session.set({ access_token: "fresh", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const fetch = vi.fn(async () => json(401, { error: { code, message: "proof required" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(unwrap(api.PATCH("/api/v1/employees/{id}", { params: { path: { id: "e1" } }, body: { expected_updated_at: "now", changes: { hire_date: "2026-01-01" }, reason_code: "TYPO" } }))).rejects.toMatchObject({ status: 401, code });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(session.token).toBe("fresh");
});
