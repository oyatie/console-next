// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { configure } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import {
  createMyProfileChangeRequest,
  issueMyCertificate,
  revealMyProfileField,
  selfEditError,
  updateEmergencyContacts,
  updatePhone,
} from "./api";

beforeAll(() => loadCatalog("ko"));
afterEach(() => vi.unstubAllGlobals());

test("revealMyProfileField binds PII_REVEAL to employeeId and SELF_REVEAL:<field> before calling /reveal", async () => {
  configure({
    baseUrl: "https://console.example",
    passkeys: { get: async () => ({ id: "cred-1" }), create: async () => null },
    refresh: { kind: "cookie" },
  });
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: Request) => {
    const path = new URL(input.url).pathname;
    const body = await input.json();
    calls.push({ path, method: input.method, body });
    if (path.endsWith("/step-up/start")) {
      return Response.json({ ceremony_id: "cer-1", challenge: { publicKey: {} } });
    }
    return Response.json({
      employee_id: "emp-1",
      field: "PHONE",
      value: "+821012345678",
      display_seconds: 15,
    });
  });

  const payload = "SELF_REVEAL:PHONE";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const expectedHash = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const revealed = await revealMyProfileField("emp-1", "PHONE");
  expect(revealed.value).toBe("+821012345678");
  expect(calls.map((c) => c.path)).toEqual(["/api/v1/auth/passkey/step-up/start", "/api/v1/me/profile/reveal"]);
  const expectedBinding = {
    action_kind: "PII_REVEAL",
    object_id: "emp-1",
    reason_key: "passkey_step_up_pii_reveal",
    replay_attempt: null,
    payload_hash: expectedHash,
  };
  expect(calls[0]!.body).toEqual({ binding: expectedBinding });
  expect(calls[1]!.body).toEqual({
    field: "PHONE",
    step_up: { binding: expectedBinding, assertion: { ceremony_id: "cer-1", credential: { id: "cred-1" } } },
  });
});

test("cancelled passkey prompt never invokes POST /api/v1/me/profile/reveal", async () => {
  configure({
    baseUrl: "https://console.example",
    passkeys: { get: async () => null, create: async () => null },
    refresh: { kind: "cookie" },
  });
  const fetchSpy = vi.fn<(input: Request) => Promise<Response>>(async () =>
    Response.json({ ceremony_id: "cer-1", challenge: { publicKey: {} } }),
  );
  vi.stubGlobal("fetch", fetchSpy);

  await expect(revealMyProfileField("emp-1", "ADDRESS")).rejects.toThrow("passkey_cancelled");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(new URL((fetchSpy.mock.calls[0]![0] as Request).url).pathname).toBe("/api/v1/auth/passkey/step-up/start");
});

test("updatePhone, updateEmergencyContacts, createMyProfileChangeRequest, and issueMyCertificate send expected payloads", async () => {
  configure({
    baseUrl: "https://console.example",
    passkeys: { get: async () => null, create: async () => null },
    refresh: { kind: "cookie" },
  });
  const requests: Array<{ method: string; path: string; body: unknown; idempotencyKey: string | null }> = [];
  vi.stubGlobal("fetch", async (input: Request) => {
    const path = new URL(input.url).pathname;
    const body = input.method === "GET" ? null : await input.json();
    requests.push({ method: input.method, path, body, idempotencyKey: input.headers.get("idempotency-key") });
    if (path === "/api/v1/me/profile") {
      return Response.json({
        employee_id: "emp-1",
        employment_status: "ACTIVE",
        phone_masked: "010-••••-5678",
        emergency_contacts_registered: true,
        emergency_contacts_count: 1,
        emergency_contacts: [],
        bank_account_registered: true,
        open_change_requests: [],
      });
    }
    return Response.json({ id: "res-1" }, { status: 201 });
  });

  await updatePhone("010-1234-5678", "010-••••-0000");
  await updateEmergencyContacts([
    { name: "Minji", relation: "SPOUSE", phone: "+821011112222", contact_notified: true },
  ]);
  await createMyProfileChangeRequest({
    field: "bank_account_registered",
    bank_account_registered: true,
    note: "Verified",
  });
  await issueMyCertificate({ kind: "EMPLOYMENT", items: ["period", "position"], purpose: "Bank" }, "cert-key-1");

  expect(requests[0]).toMatchObject({ method: "PATCH", path: "/api/v1/me/profile", body: { phone: "010-1234-5678" } });
  expect(requests[1]).toMatchObject({
    method: "PATCH",
    path: "/api/v1/me/profile",
    body: {
      emergency_contacts: [{ name: "Minji", relation: "SPOUSE", phone: "+821011112222", contact_notified: true }],
    },
  });
  expect(requests[2]).toMatchObject({
    method: "POST",
    path: "/api/v1/me/profile/change-requests",
    body: { field: "bank_account_registered", bank_account_registered: true, note: "Verified" },
  });
  expect(requests[3]).toMatchObject({
    method: "POST",
    path: "/api/v1/me/certificates",
    idempotencyKey: "cert-key-1",
    body: { kind: "EMPLOYMENT", items: ["period", "position"], purpose: "Bank" },
  });

  expect(selfEditError("change_request_already_open")).toBe(t("account.selfEdit.error.change_request_already_open"));
  expect(selfEditError("reveal_rate_limited")).toBe(t("account.selfEdit.error.reveal_rate_limited"));
  expect(selfEditError("certificate_settings_required")).toBe(t("empDoc.certificate.error.certificate_settings_required"));
});
