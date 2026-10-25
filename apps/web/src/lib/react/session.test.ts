// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { configure, consentStatus, session } from "@console/api";
import { ensureSession } from "./session";
vi.mock("@console/api", async original => ({ ...await original<typeof import("@console/api")>(), consentStatus: vi.fn(async () => ({ accepted: true })) }));

afterEach(() => { session.set(null); vi.unstubAllGlobals(); });
test("cold restoration belongs inside the shell, never in a blocking route guard", async () => {
  configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
  const fetch = vi.fn(async () => { throw new TypeError("offline"); });
  vi.stubGlobal("fetch", fetch);
  await expect(ensureSession({ location: { pathname: "/org/entities" } })).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

test("tenant admins receive not-found at /platform", async () => {
  const token = `h.${btoa(JSON.stringify({ sub: "u", org: "o", platform: false, roles: ["ADMIN"] }))}.s`;
  session.set({ access_token: token, token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false, privacy_consent_accepted: true });
  await expect(ensureSession({ location: { pathname: "/platform" } })).rejects.toMatchObject({ isNotFound: true });
  expect(consentStatus).not.toHaveBeenCalled();
});
