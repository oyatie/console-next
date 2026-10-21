import { afterEach, expect, test, vi } from "vitest";
import { authPost, configure, renewDelay, RENEW_LEAD_MS, session, type Platform, type TokenPair } from "./index";

// The access token is renewed before it expires (so the event stream, closed by the server at expiry, reopens with a
// fresh one and never meets a 401), on the server's clock, and only when renewing gains anything.
const MIN = 60_000;
const passkeys: Platform["passkeys"] = { get: async () => null, create: async () => null };
const token = (exp: number) =>
  `h.${btoa(JSON.stringify({ sub: "u1", org: "o1", roles: ["HR_ADMIN"], platform: false, read_only: false, exp })).replace(/=+$/, "")}.s`;
const pair = (exp: number) => ({ access_token: token(exp), token_type: "Bearer" as const, refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
afterEach(() => {
  session.set(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("renewal is due the lead before expiry, on the server's clock, and never for a token that ends sooner", () => {
  const now = 1_800_000_000_000;
  const exp = (now + 15 * MIN) / 1000;
  expect(renewDelay(exp, now, 0)).toBe(15 * MIN - RENEW_LEAD_MS);
  // The server's clock runs 5 minutes ahead of this PC: its expiry comes 5 minutes sooner here.
  expect(renewDelay(exp, now, 5 * MIN)).toBe(10 * MIN - RENEW_LEAD_MS);
  // At the boundary: a token with exactly the lead left (or less, or already expired) is not renewed ahead.
  expect(renewDelay(now / 1000 + RENEW_LEAD_MS / 1000 + 0.001, now, 0)).toBe(1);
  expect(renewDelay(now / 1000 + RENEW_LEAD_MS / 1000, now, 0)).toBeNull();
  expect(renewDelay(now / 1000 - 1, now, 0)).toBeNull();
  expect(renewDelay(undefined, now, 0)).toBeNull();
});

test("a signed-in session refreshes once at the renewal time, and an ended one never", async () => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  const refreshes: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    refreshes.push(new URL(new Request(input, init).url).pathname);
    return new Response(JSON.stringify(pair(Date.now() / 1000 + 15 * 60)), { status: 200, headers: { "content-type": "application/json" } });
  });
  session.set(pair(Date.now() / 1000 + 15 * 60));
  await vi.advanceTimersByTimeAsync(15 * MIN - RENEW_LEAD_MS - 1);
  expect(refreshes).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(refreshes).toEqual(["/api/v1/auth/token/refresh"]);
  // The renewed token is renewed in its turn.
  await vi.advanceTimersByTimeAsync(15 * MIN - RENEW_LEAD_MS);
  expect(refreshes).toHaveLength(2);

  session.expire("session_idle_expired"); // ended (here: for inactivity): nothing more is sent
  await vi.advanceTimersByTimeAsync(60 * MIN);
  expect(refreshes).toHaveLength(2);
});

test("login response time is learned before the renewal timer is scheduled", async () => {
  const clientNow = 1_800_000_000_000;
  const serverAhead = 5 * MIN;
  vi.useFakeTimers({ now: clientNow });
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    calls.push(new URL(new Request(input, init).url).pathname);
    const serverNow = Date.now() + serverAhead;
    return new Response(JSON.stringify(pair(serverNow / 1000 + 15 * 60)), {
      status: 200,
      headers: { "content-type": "application/json", date: new Date(serverNow).toUTCString() },
    });
  });

  session.set(await authPost<TokenPair>("/api/v1/auth/passkey/login/finish"));
  await vi.advanceTimersByTimeAsync(13 * MIN - 1);
  expect(calls).toEqual(["/api/v1/auth/passkey/login/finish"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toEqual([
    "/api/v1/auth/passkey/login/finish",
    "/api/v1/auth/token/refresh",
  ]);
});
