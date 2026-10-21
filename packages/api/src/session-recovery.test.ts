// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { authFetch, configure, session, type Platform } from "./index";

const pair = (sub = "same", org = "tenant") => ({
  access_token: `h.${btoa(JSON.stringify({ sub, org, roles: [], platform: false, read_only: false }))}.s`,
  token_type: "Bearer" as const, refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const passkeys: Platform["passkeys"] = { get: async () => null, create: async () => null };
const reasons = ["session_expired", "session_revoked", "session_passkey_reset", "session_deactivated", "session_signed_out_elsewhere", "session_idle_expired"];
afterEach(() => { session.set(null); vi.unstubAllGlobals(); });

function interrupted(reason: string, signal?: AbortSignal) {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  session.set(pair());
  const writes: Request[] = [];
  const fetch = vi.fn(async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/refresh")) return json(401, { error: { code: reason, message: "ended" } });
    writes.push(request);
    return writes.length === 1 ? json(401, { error: { code: "unauthorized", message: "ended" } }) : json(200, { saved: true });
  });
  vi.stubGlobal("fetch", fetch);
  const result = authFetch(new Request("https://console.example/api/v1/report", { method: "POST", headers: { "idempotency-key": "original-key" }, body: JSON.stringify({ note: "original input" }), signal }));
  return { result, writes, fetch };
}

test.each(reasons)("%s keeps the reason and resumes the frozen write exactly once for the same account", async (reason) => {
  const { result, writes } = interrupted(reason);
  let settled = false;
  void result.then(() => { settled = true; });
  await vi.waitFor(() => expect(session.ended).toBe(reason));
  expect(settled).toBe(false);
  expect(writes).toHaveLength(1);
  session.set(pair());
  expect((await result).status).toBe(200);
  session.set(pair()); // renewal / repeated notification cannot replay twice
  await Promise.resolve();
  expect(writes).toHaveLength(2);
  expect(writes.map((r) => r.headers.get("idempotency-key"))).toEqual(["original-key", "original-key"]);
  expect(await writes[1]!.text()).toBe(await writes[0]!.text());
});

test.each([["different", "tenant"], ["same", "different-tenant"], [null, null]])("replacement %s/%s never receives an interrupted write", async (sub, org) => {
  const { result, writes } = interrupted("session_revoked");
  let settled = false;
  void result.then(() => { settled = true; });
  await vi.waitFor(() => expect(session.lost).toBe(true));
  expect(settled).toBe(false);
  session.set(sub && org ? pair(sub, org) : null);
  expect((await result).status).toBe(401);
  expect(writes).toHaveLength(1);
});

test("an aborted screen never replays after signing in", async () => {
  const controller = new AbortController();
  const { result, writes } = interrupted("session_expired", controller.signal);
  const refused = result.then((response) => ({ response }), (error: unknown) => ({ error }));
  await vi.waitFor(() => expect(session.lost).toBe(true));
  controller.abort();
  expect(await refused).toMatchObject({ error: { status: 0 } });
  session.set(pair());
  expect(writes).toHaveLength(1);
});
