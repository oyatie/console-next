// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { acceptConsent, configure, session } from "@console/api";
import { consentDestination, ensureSession, ensureEnrolling } from "./session";

const pair = (accepted?: boolean) => ({
  access_token: `h.${btoa(JSON.stringify({ sub: "user", org: "tenant", platform: false }))}.s`,
  token_type: "Bearer" as const, requires_passkey_setup: false,
  refresh_expires_at: "2027-01-01T00:00:00Z", privacy_consent_accepted: accepted,
});
const fetch = vi.fn();
beforeEach(() => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ accepted: true })));
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => { session.set(null); vi.unstubAllGlobals(); });

test("ten route changes use the accepted session with zero consent requests", async () => {
  session.set(pair(true));
  for (let i = 0; i < 10; i++) await ensureSession({ location: { pathname: i % 2 ? "/account" : "/people" } });
  expect(fetch).toHaveBeenCalledTimes(0);
  await expect(ensureEnrolling()).rejects.toMatchObject({ options: { to: "/" } });
});

test.each([false, undefined])("consent %s keeps a deep link on setup without a request", async (accepted) => {
  session.set(pair(accepted));
  await expect(ensureSession({ location: { pathname: "/people/new" } })).rejects.toMatchObject({ options: { to: "/setup-passkey" } });
  await expect(ensureEnrolling()).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(0);
});

test("accept response opens the app locally; replacement session re-evaluates consent", async () => {
  session.set(pair(false));
  await acceptConsent({ version: "terms", sha256: "terms-hash", body: "Terms", privacy: { version: "privacy", sha256: "privacy-hash", body: "Privacy", policy_url: "https://example.com/privacy", review_pending: false } });
  await ensureSession({ location: { pathname: "/people/new" } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("https://console.example/api/v1/auth/privacy-consent/accept");
  session.set(pair(false));
  await expect(ensureSession({ location: { pathname: "/people" } })).rejects.toMatchObject({ options: { to: "/setup-passkey" } });
});

test("a refused acceptance cannot open the app", async () => {
  session.set(pair(false));
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: "terms_text_changed", message: "Review current documents" } }), { status: 409 }));
  await expect(acceptConsent({ version: "terms", sha256: "old", body: "Terms", privacy: { version: "privacy", sha256: "old", body: "Privacy", policy_url: "https://example.com/privacy", review_pending: false } })).rejects.toMatchObject({ code: "terms_text_changed" });
  await expect(ensureSession({ location: { pathname: "/people" } })).rejects.toMatchObject({ options: { to: "/setup-passkey" } });
});

test("a late acceptance cannot open a replacement account", async () => {
  session.set(pair(false));
  let deliver!: (response: Response) => void;
  fetch.mockImplementation(() => new Promise<Response>((resolve) => { deliver = resolve; }));
  const accepting = acceptConsent({ version: "terms", sha256: "hash", body: "Terms", privacy: { version: "privacy", sha256: "hash", body: "Privacy", policy_url: "https://example.com/privacy", review_pending: false } });
  session.set({ ...pair(false), access_token: `h.${btoa(JSON.stringify({ sub: "other", org: "tenant" }))}.s` });
  deliver(new Response(JSON.stringify({ accepted: true })));
  await accepting;
  await expect(ensureSession({ location: { pathname: "/people" } })).rejects.toMatchObject({ options: { to: "/setup-passkey" } });
});

test("changed documents preserve the interrupted URL for this account only", async () => {
  session.set(pair(true));
  session.setConsentAccepted(false);
  await expect(ensureSession({ location: { pathname: "/people", href: "/people?q=Kim#person" } })).rejects.toMatchObject({ options: { to: "/setup-passkey" } });
  await expect(ensureEnrolling()).resolves.toBeUndefined();
  session.setConsentAccepted(true);
  expect(consentDestination()).toBe("/people?q=Kim#person");
  session.set({ ...pair(true), access_token: `h.${btoa(JSON.stringify({ sub: "other", org: "tenant" }))}.s` });
  expect(consentDestination()).toBe("/");
});
