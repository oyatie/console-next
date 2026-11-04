// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { configure } from "@console/api";
import { filePrivacyRequest } from "./api";

afterEach(() => vi.unstubAllGlobals());

test("filing verifies the canonical payload before posting with its intent key", async () => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => ({ id: "credential" }), create: async () => null }, refresh: { kind: "cookie" } });
  const requests: { path: string; body: unknown; key: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: Request) => {
    const path = new URL(input.url).pathname;
    requests.push({ path, body: await input.json(), key: input.headers.get("idempotency-key") });
    return Response.json(path.endsWith("/start") ? { ceremony_id: "ceremony", challenge: { publicKey: {} } } : { id: "receipt" });
  });
  const input = { controller: "OPERATOR" as const, kinds: ["WITHDRAWAL" as const, "ACCESS" as const], detail: "한글\n기록" };
  const payload = JSON.stringify(input);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hash = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
  expect(await filePrivacyRequest("subject", input, "request-intent-key")).toEqual({ id: "receipt" });
  expect(requests.map(request => request.path)).toEqual(["/api/v1/auth/passkey/step-up/start", "/api/v1/privacy/rights-requests"]);
  const binding = { action_kind: "PRIVACY_REQUEST", object_id: "subject", reason_key: "passkey_step_up_privacy_request", replay_attempt: null, payload_hash: hash };
  expect(requests[0]!.body).toEqual({ binding });
  expect(requests[1]).toMatchObject({ key: "request-intent-key", body: { ...input, step_up: { binding, assertion: { ceremony_id: "ceremony", credential: { id: "credential" } } } } });
});

test("a cancelled passkey sends no filing command", async () => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  const fetch = vi.fn(async () => Response.json({ ceremony_id: "ceremony", challenge: { publicKey: {} } }));
  vi.stubGlobal("fetch", fetch);
  await expect(filePrivacyRequest("subject", { controller: "OPERATOR", kinds: ["ACCESS"] }, "request-intent-key")).rejects.toThrow("passkey_cancelled");
  expect(fetch).toHaveBeenCalledTimes(1);
});
