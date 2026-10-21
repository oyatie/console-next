import { afterEach, expect, test, vi } from "vitest";
import { api, configure, consentStatus, refresh, session, touch, unwrap, type Platform } from "./index";

// INF-03 / decisions #8c, client side: activity rides on `X-Last-Interaction`; only a 401 from refresh ends a
// session, and a session that ends in use is kept "lost" (claims kept) for re-auth in place.
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const passkeys: Platform["passkeys"] = { get: async () => null, create: async () => null };
const jwt = `h.${btoa(JSON.stringify({ sub: "u1", org: "o1", roles: ["HR_ADMIN"], platform: false, read_only: false })).replace(/=+$/, "")}.s`;
const pair = (access_token = jwt) => ({ access_token, token_type: "Bearer" as const, refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
const signedIn = () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  session.set(pair());
};
afterEach(() => {
  vi.unstubAllGlobals();
  session.set(null);
});

test("every authenticated request carries the last interaction, on the server's clock", async () => {
  signedIn();
  const sent: (string | null)[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push(req.headers.get("x-last-interaction"));
    // The server's clock runs 5 minutes ahead of this PC.
    return json(200, { accepted: true }, { date: new Date(Date.now() + 300_000).toUTCString() });
  });
  await unwrap(api.GET("/api/v1/users/me")); // before any input: no header (it would never advance activity)
  const at = Date.parse("2026-10-04T01:00:00Z");
  touch(at);
  await unwrap(api.GET("/api/v1/users/me"));
  await consentStatus(); // bearer auth calls too
  expect(sent[0]).toBeNull();
  for (const v of sent.slice(1)) {
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(v!) - (at + 300_000))).toBeLessThan(2_000);
  }
});

for (const [what, fail] of [
  ["a 503", () => json(503, { error: { code: "service_unavailable", message: "down" } })],
  ["a 429", () => json(429, { error: { code: "rate_limited", message: "slow down" } })],
  ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
] as const)
  test(`a refresh that fails with ${what} keeps the session`, async () => {
    signedIn();
    vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
      const req = new Request(input, init);
      return req.url.endsWith("/api/v1/auth/token/refresh") ? fail() : json(401, { error: { code: "unauthorized", message: "expired" } });
    });
    await expect(unwrap(api.GET("/api/v1/users/me"))).rejects.toBeDefined();
    expect(session.token).toBe(jwt);
    expect(session.lost).toBe(false);
  });

test("a refused refresh ends a session in use as lost; nothing is sent again until a sign-in", async () => {
  signedIn();
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    calls.push(new URL(new Request(input, init).url).pathname);
    return json(401, { error: { code: "unauthorized", message: "family revoked" } });
  });
  let emitted = 0;
  const off = session.subscribe(() => void emitted++);
  await expect(unwrap(api.GET("/api/v1/users/me"))).rejects.toMatchObject({ status: 401 });
  expect(session).toMatchObject({ token: null, lost: true });
  expect(session.claims?.sub).toBe("u1"); // who to sign back in
  expect(await refresh()).toBe(false);
  await expect(unwrap(api.GET("/api/v1/users/me"))).rejects.toMatchObject({ status: 401 });
  expect(calls).toEqual(["/api/v1/users/me", "/api/v1/auth/token/refresh", "/api/v1/users/me"]);
  expect(emitted).toBe(1);
  off();
  session.set(pair());
  expect(session.lost).toBe(false);
});

test("a one-time-code session that ends is signed out, not lost (it has no passkey to sign back in with)", async () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  const otp = `h.${btoa(JSON.stringify({ sub: "u1", org: "o1", roles: [], platform: false, read_only: false, enrollment: true })).replace(/=+$/, "")}.s`;
  session.set({ ...pair(otp), requires_passkey_setup: true });
  vi.stubGlobal("fetch", async () => json(401, { error: { code: "unauthorized", message: "family revoked" } }));
  expect(await refresh()).toBe(false);
  expect(session).toMatchObject({ token: null, claims: null, lost: false });
});

test("a cold start without a session is not lost", async () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  vi.stubGlobal("fetch", async () => json(401, { error: { code: "unauthorized", message: "missing refresh token" } }));
  expect(await refresh()).toBe(false);
  expect(session).toMatchObject({ token: null, claims: null, lost: false });
});

test("the refusal that ends a session says why, in use and on a cold start, until the next sign-in", async () => {
  // In use: the 401 that sends the client to refresh, then the server's idle refusal (INF-03).
  signedIn();
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) =>
    new Request(input, init).url.endsWith("/api/v1/auth/token/refresh")
      ? json(401, { error: { code: "session_idle_expired", message: "session ended for inactivity" } })
      : json(401, { error: { code: "unauthorized", message: "invalid token" } }),
  );
  await expect(unwrap(api.GET("/api/v1/users/me"))).rejects.toMatchObject({ status: 401 });
  expect(session).toMatchObject({ lost: true, ended: "session_idle_expired" });
  session.set(pair());
  expect(session.ended).toBeNull();

  // A reload: no session to keep, and the sign-in screen still learns why.
  session.set(null);
  expect(await refresh()).toBe(false);
  expect(session).toMatchObject({ token: null, lost: false, ended: "session_idle_expired" });
  vi.stubGlobal("fetch", async () => json(401, { error: { code: "unauthorized", message: "family revoked" } }));
  expect(await refresh()).toBe(false);
  expect(session.ended).toBe("unauthorized");
});
