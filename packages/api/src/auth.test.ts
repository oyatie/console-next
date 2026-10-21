import { afterEach, expect, test, vi } from "vitest";
import { configure, lastSignInId, lastSignInProfile, loginWithPasskey, logout, redeemOtp, registerPasskey, session, type Platform } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
  session.set(null);
});

test("an OTP response replaces concurrent autofill labels with its own session", async () => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => ({}), create: async () => null }, refresh: { kind: "cookie" } });
  let deliverOtp!: (response: Response) => void;
  let started!: () => void;
  const otpStarted = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path.endsWith("/otp/redeem")) {
      started();
      return new Promise<Response>((resolve) => { deliverOtp = resolve; });
    }
    return new Response(JSON.stringify(path.endsWith("/start")
      ? { ceremony_id: "ceremony", challenge: { publicKey: {} } }
      : { access_token: "passkey-token", token_type: "Bearer", passkey_profile: { user_id: "user-a", name: "hong@company-a", display_name: "Hong" } }));
  });
  const otp = redeemOtp("new-code");
  await otpStarted;
  await loginWithPasskey({ identifier: "hong@company-a" });
  expect(lastSignInProfile()?.name).toBe("hong@company-a");
  deliverOtp(new Response(JSON.stringify({ access_token: "otp-token", token_type: "Bearer", requires_passkey_setup: true })));
  await otp;
  expect(session.token).toBe("otp-token");
  expect(lastSignInProfile()).toBeUndefined();
  expect(lastSignInId()).toBeUndefined();
});

test.each(["cookie", "body"] as const)("%s logout uses only the refresh credential and never refreshes a refusal", async (kind) => {
  let stored: string | null = "refresh-token";
  configure({
    baseUrl: "https://console.example",
    passkeys: { get: async () => null, create: async () => null },
    refresh: kind === "cookie" ? { kind } : { kind, load: async () => stored, save: async (token) => void (stored = token) },
  });
  session.set({ access_token: "access-token", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({ error: { code: "unauthorized", message: "revoked" } }), { status: 401 });
  });

  await logout();

  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.url).toBe("https://console.example/api/v1/auth/logout");
  expect(request.headers.get("authorization")).toBeNull();
  expect(request.headers.get("x-auth-transport")).toBe(kind === "cookie" ? "cookie" : null);
  expect(request.credentials).toBe(kind === "cookie" ? "same-origin" : "omit");
  expect(await request.json()).toEqual(kind === "cookie" ? {} : { refresh_token: "refresh-token" });
  expect(session.token).toBeNull();
  if (kind === "body") expect(stored).toBeNull();
});

test.each(["cookie", "body"] as const)("%s initial enrollment logs out without a bearer before passkey sign-in", async (kind) => {
  let stored: string | null = "enrollment-refresh";
  const passkeys: Platform["passkeys"] = { get: async () => ({}), create: async () => ({}) };
  configure({
    baseUrl: "https://console.example",
    passkeys,
    refresh: kind === "cookie" ? { kind } : { kind, load: async () => stored, save: async (token) => void (stored = token) },
  });
  session.set({ access_token: "enrollment-token", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: true });
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path.endsWith("/logout")) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(await request.json()).toEqual(kind === "cookie" ? {} : { refresh_token: "enrollment-refresh" });
      return new Response(null, { status: 204 });
    }
    if (path.includes("/register/")) expect(request.headers.get("authorization")).toBe("Bearer enrollment-token");
    if (path.endsWith("/register/finish")) return new Response(JSON.stringify({
      passkey_id: "passkey", user_id: "user", credential_id: "credential", sign_in_id: "kim.id@acme",
    }), { status: 201 });
    if (path.endsWith("/login/start")) expect(await request.json()).toEqual({ identifier: "kim.id@acme" });
    const body = path.endsWith("/start")
      ? { ceremony_id: "ceremony", challenge: { publicKey: {} } }
      : { access_token: "passkey-token", refresh_token: kind === "body" ? "passkey-refresh" : null, token_type: "Bearer", requires_passkey_setup: false };
    return new Response(JSON.stringify(body), { status: 200 });
  });

  expect(await registerPasskey()).toBe("kim.id@acme");

  expect(paths).toEqual([
    "/api/v1/auth/passkey/register/start",
    "/api/v1/auth/passkey/register/finish",
    "/api/v1/auth/logout",
    "/api/v1/auth/passkey/login/start",
    "/api/v1/auth/passkey/login/finish",
  ]);
  expect(session.token).toBe("passkey-token");
  if (kind === "body") expect(stored).toBe("passkey-refresh");
});
