// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const pair = (sub = "user") => ({ access_token: `h.${btoa(JSON.stringify({ sub, org: "tenant" }))}.s`, token_type: "Bearer" as const, refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false, privacy_consent_accepted: true });
beforeEach(() => {
  vi.resetModules();
  const values: Record<string, string> = {};
  vi.stubGlobal("sessionStorage", new Proxy(values, { get: (target, key) => {
    if (key === "getItem") return (name: string) => target[name] ?? null;
    if (key === "setItem") return (name: string, value: string) => { target[name] = value; };
    if (key === "removeItem") return (name: string) => { delete target[name]; };
    return Reflect.get(target, key);
  } }));
});
afterEach(async () => { (await import("@console/api")).session.set(null); vi.unstubAllGlobals(); });

async function interrupt() {
  const { session } = await import("@console/api");
  const { syncDraftPrincipal } = await import("./draft-owner");
  session.set(pair());
  syncDraftPrincipal(session.principal);
  (await import("./session")).rememberInterrupted("/people/person?view=history#report");
}

test("a code-step reload retains the return URL only for its draft owner", async () => {
  await interrupt();
  vi.resetModules(); // Reload: only sessionStorage survives.
  const { session } = await import("@console/api");
  const { consentDestination } = await import("./session");
  session.set(pair("other"));
  expect(consentDestination()).toBe("/");
  session.set(pair());
  expect(consentDestination()).toBe("/people/person?view=history#report");
});

test("account replacement purges the persisted return URL", async () => {
  await interrupt();
  const { syncDraftPrincipal } = await import("./draft-owner");
  syncDraftPrincipal("other-account");
  vi.resetModules();
  (await import("@console/api")).session.set(pair());
  expect((await import("./session")).consentDestination()).toBe("/");
});

test("reset during consent keeps the original interrupted URL", async () => {
  await interrupt();
  const { rememberInterrupted, consentDestination } = await import("./session");
  rememberInterrupted("/setup-passkey");
  expect(consentDestination()).toBe("/people/person?view=history#report");
});

test("entering the restored app consumes its return URL", async () => {
  await interrupt();
  await (await import("./session")).ensureSession({ location: { pathname: "/people/person" } });
  vi.resetModules();
  (await import("@console/api")).session.set(pair());
  expect((await import("./session")).consentDestination()).toBe("/");
});


test("sign-out clears the in-memory return even when the same account later signs in", async () => {
  await interrupt();
  const { session } = await import("@console/api");
  const { syncDraftPrincipal } = await import("./draft-owner");
  const { consentDestination } = await import("./session");
  session.set(null);
  syncDraftPrincipal(null);
  session.set(pair());
  expect(consentDestination()).toBe("/");
});

test.each(["//outside.example/path", "https://outside.example/path", "invalid-json"])("a malformed stored return %s cannot navigate outside the app", async href => {
  await interrupt();
  vi.resetModules();
  const { session } = await import("@console/api");
  const { draftKey } = await import("./draft-owner");
  session.set(pair());
  sessionStorage.setItem(draftKey(session.principal!, "session", "", "return"), href);
  expect((await import("./session")).consentDestination()).toBe("/");
});

test("blocked storage keeps the current tab's return URL", async () => {
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  const { session } = await import("@console/api");
  const { rememberInterrupted, consentDestination } = await import("./session");
  session.set(pair());
  rememberInterrupted("/people/person");
  expect(consentDestination()).toBe("/people/person");
});


test("blocked removal cannot restore a consumed return when storage becomes available again", async () => {
  await interrupt();
  const store = sessionStorage;
  vi.stubGlobal("sessionStorage", { removeItem: () => { throw new Error("blocked"); } });
  const { ensureSession, consentDestination } = await import("./session");
  await ensureSession({ location: { pathname: "/people/person" } });
  vi.stubGlobal("sessionStorage", store);
  expect(consentDestination()).toBe("/");
});
