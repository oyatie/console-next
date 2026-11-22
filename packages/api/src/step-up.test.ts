import { afterEach, expect, test, vi } from "vitest";
import { configure } from "./client";
import { assertBoundPasskey, assertBoundPasskeyHash, assertSettingsChangeStepUp, sha256Hex } from "./step-up";

afterEach(() => vi.unstubAllGlobals());

test("the payload hash is the lowercase hex SHA-256 of the UTF-8 text", async () => {
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(await sha256Hex("PERIOD_UNLOCK\nx\nRETRO_CORRECTION\n2026-10-05T00:00:00Z")).toMatch(/^[0-9a-f]{64}$/);
});

test.each(["payload", "hash"] as const)("a bound passkey uses the %s without changing its hash", async (kind) => {
  const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const get = vi.fn(async () => ({ id: "credential" }));
  configure({ baseUrl: "https://console.example", passkeys: { get, create: async () => null }, refresh: { kind: "cookie" } });
  let sent: unknown;
  const publicKey = { challenge: "challenge" };
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    sent = await new Request(input, init).json();
    return new Response(JSON.stringify({ ceremony_id: "ceremony", challenge: { publicKey } }), { headers: { "content-type": "application/json" } });
  });

  const envelope = await (kind === "payload" ? assertBoundPasskey("EXCEPTION_DECIDE", "exception", "abc") : assertBoundPasskeyHash("EXCEPTION_DECIDE", "exception", hash));

  expect(sent).toEqual({ binding: { action_kind: "EXCEPTION_DECIDE", object_id: "exception", reason_key: "passkey_step_up_exception_decide", replay_attempt: null, payload_hash: hash } });
  expect(envelope).toEqual({ ...(sent as object), assertion: { ceremony_id: "ceremony", credential: { id: "credential" } } });
  expect(get).toHaveBeenCalledExactlyOnceWith(publicKey);
});

test.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), ` ${"a".repeat(64)}`])("an invalid supplied hash refuses before starting a ceremony: %s", async (hash) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(assertBoundPasskeyHash("EXCEPTION_DECIDE", "exception", hash)).rejects.toThrow("passkey_payload_hash_invalid");
  expect(fetch).not.toHaveBeenCalled();
});

test("assertSettingsChangeStepUp binds SETTINGS_CHANGE to canonical {key,value} JSON", async () => {
  const get = vi.fn(async () => ({ id: "cred-1" }));
  configure({ baseUrl: "https://console.example", passkeys: { get, create: async () => null }, refresh: { kind: "cookie" } });
  let sent: unknown;
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    sent = await new Request(input, init).json();
    return new Response(JSON.stringify({ ceremony_id: "cer-settings", challenge: { publicKey: { challenge: "c" } } }), {
      headers: { "content-type": "application/json" },
    });
  });

  const expectedHash = await sha256Hex('{"key":"approval.policy.org_structure","value":"none"}');
  const envelope = await assertSettingsChangeStepUp("approval.policy.org_structure", "none", null);
  expect(sent).toEqual({
    binding: {
      action_kind: "SETTINGS_CHANGE",
      object_id: "00000000-0000-0000-0000-000000000000",
      reason_key: "passkey_step_up_settings_change",
      replay_attempt: null,
      payload_hash: expectedHash,
    },
  });
  expect(envelope).toEqual({
    ...(sent as object),
    assertion: { ceremony_id: "cer-settings", credential: { id: "cred-1" } },
  });

  const settingId = "attendance.week52.warn_hours";
  const entityEnvelope = await assertSettingsChangeStepUp(settingId, 48, "11111111-1111-4111-8111-111111111111");
  expect(entityEnvelope.binding.object_id).toBe("11111111-1111-4111-8111-111111111111");
  expect(entityEnvelope.binding.payload_hash).toBe(await sha256Hex(JSON.stringify({ key: settingId, value: 48 })));
});
