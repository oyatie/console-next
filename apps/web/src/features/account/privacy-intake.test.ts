// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, describe, expect, test, vi } from "vitest";
import { configure, sha256Hex } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import {
  ApiError,
  decidePrivacyRequest,
  postponePrivacyRequest,
  privacyLifecycleError,
  privacyOutcomeSupported,
  privacyRefusalReasonDomain,
} from "./api/privacy-intake";

beforeAll(() => loadCatalog("ko"));

describe("privacy lifecycle rules and canonical step-up payloads", () => {
  test("CORRECTION supports GRANTED only while refusal domains match statutory kinds", () => {
    expect(privacyOutcomeSupported("CORRECTION", "GRANTED")).toBe(true);
    expect(privacyOutcomeSupported("CORRECTION", "PARTIAL")).toBe(false);
    expect(privacyOutcomeSupported("CORRECTION", "REFUSED")).toBe(false);
    expect(privacyOutcomeSupported("ACCESS", "REFUSED")).toBe(true);
    expect(privacyRefusalReasonDomain("ACCESS")).toBe("privacy_refusal_access");
    expect(privacyRefusalReasonDomain("DELETION")).toBe("privacy_refusal_deletion");
    expect(privacyRefusalReasonDomain("SUSPENSION")).toBe("privacy_refusal_suspension");
    expect(privacyRefusalReasonDomain("CORRECTION")).toBeNull();
  });

  test("maps all privacy refusal error codes from privacy-errors catalog", () => {
    const codes = [
      "own_request_forbidden",
      "objection_same_decider",
      "postpone_not_allowed",
      "request_already_decided",
      "mandate_required",
      "privacy.refuse.identity_unbound",
      "objection_before_result",
      "request_kind_unavailable",
      "request_kind_required",
      "reason_code_invalid",
      "reason_note_required",
      "decision_date_invalid",
      "received_on_invalid",
      "detail_too_long",
      "no_employee_record",
      "request_controller_unavailable",
      "privacy_subject_not_found",
      "privacy_request_not_decided",
      "privacy_controller_invalid",
    ] as const;
    for (const code of codes) {
      const msg = privacyLifecycleError(new ApiError(403, code, "", []));
      expect(msg, code).toBeTruthy();
      expect(msg).not.toBe(`privacy.err.${code}`);
    }
    expect(privacyLifecycleError(new ApiError(403, "privacy.refuse.identity_unbound", "", []))).toBe(
      t("privacy.refuse.identity_unbound"),
    );
  });

  test("decidePrivacyRequest and postponePrivacyRequest bind exact canonical JSON hashes", async () => {
    const reqId = "11111111-1111-4111-8111-111111111111";
    const getPasskey = vi.fn(async () => ({ id: "cred" }));
    configure({ baseUrl: "https://console.example", passkeys: { get: getPasskey, create: async () => null }, refresh: { kind: "cookie" } });
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      bodies.push({ path: url.pathname, body: await req.json() });
      if (url.pathname.endsWith("/step-up/start")) {
        return new Response(JSON.stringify({ ceremony_id: "c1", challenge: { publicKey: { challenge: "c" } } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: reqId }), { headers: { "content-type": "application/json" } });
    });

    await decidePrivacyRequest(reqId, { kind: "ACCESS", outcome: "REFUSED", reason: "LAW_PROHIBITS", note: "note" }, "idem-1234567890123456");
    const expectedDecideHash = await sha256Hex('{"kind":"ACCESS","outcome":"REFUSED","reason":"LAW_PROHIBITS","note":"note","decided_on":null}');
    expect((bodies[0] as { body: { binding: { action_kind: string; object_id: string; payload_hash: string } } }).body.binding).toMatchObject({
      action_kind: "PRIVACY_REQUEST_DECIDE",
      object_id: reqId,
      payload_hash: expectedDecideHash,
    });

    await postponePrivacyRequest(reqId, { kind: "ACCESS", reason: "JUSTIFIED_REASON", note: "waiting" }, "idem-2234567890123456");
    const expectedPostponeHash = await sha256Hex('{"kind":"ACCESS","reason":"JUSTIFIED_REASON","note":"waiting","decided_on":null}');
    expect((bodies[2] as { body: { binding: { action_kind: string; object_id: string; payload_hash: string } } }).body.binding).toMatchObject({
      action_kind: "PRIVACY_REQUEST_DECIDE",
      object_id: reqId,
      payload_hash: expectedPostponeHash,
    });
    vi.unstubAllGlobals();
  });
});
