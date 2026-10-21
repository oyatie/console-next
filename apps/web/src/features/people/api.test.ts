import { expect, test, vi } from "vitest";
import { configure, session } from "@console/api";
import { correctEvent, createEmployee, type CreateEmployee } from "./api";

test("a lost lifecycle correction response keeps the command's key on replay", async () => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  session.set({ access_token: "fresh", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const key = crypto.randomUUID();
  const keys: (string | null)[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    keys.push(request.headers.get("idempotency-key"));
    if (keys.length === 1) throw new TypeError("lost response");
    return new Response(JSON.stringify({ id: "corrected" }), { headers: { "content-type": "application/json" } });
  });
  const send = () => correctEvent({ id: "event-1", employee_id: "person-1" }, { event_type: "PROMOTE", effective_date: "2026-10-09", comment: "correction", to_position: "manager" }, { reason_code: "TYPO" }, key);
  try {
    await expect(send()).rejects.toMatchObject({ code: "command_unknown", requestKey: key });
    await expect(send()).resolves.toMatchObject({ id: "corrected" });
    expect(keys).toEqual([key, key]);
  } finally {
    vi.unstubAllGlobals();
    session.set(null);
  }
});

test("registration uses one intent key for its employee body and command ledger header", async () => {
  const body = { idempotency_key: "original-registration" } as CreateEmployee;
  configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
  const sent: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    return new Response(JSON.stringify({ employee: { id: "registered" } }), { status: 201, headers: { "content-type": "application/json" } });
  });
  try {
    await createEmployee(body);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("Idempotency-Key")).toBe(body.idempotency_key);
    expect(await sent[0]!.json()).toEqual(body);
  } finally {
    vi.unstubAllGlobals();
  }
});
