import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { correctIdentifier, correctRegistrationNumber, registrationEndQuery, voidRegistration } from "./api";

const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const assertion = vi.hoisted(() => ({ assertion: { ceremony_id: "ceremony", credential: {} } }));
vi.mock("@console/api", async (original) => ({
  ...(await original<typeof import("@console/api")>()),
  api: { POST: post, GET: get },
  assertBoundPasskey: vi.fn(async () => assertion),
}));
afterEach(() => { post.mockReset(); get.mockReset(); });
const body = { value: "0008162529", document_id: "evidence", reason_code: "TYPO_AT_ENTRY" as const };
const send = [
  () => correctIdentifier("original", "entity", { field: "crn", ...body }),
  () => correctRegistrationNumber("original", "registration", body),
];

test.each(send)("step-up sends an authenticated intent with a fresh key after the answered refusal", async (correct) => {
  post.mockResolvedValueOnce({ response: new Response(null, { status: 428 }), error: { error: { code: "passkey_step_up_required", message: "required" } } });
  post.mockResolvedValueOnce({ response: new Response(null, { status: 200 }), data: { corrected: true } });
  await expect(correct()).resolves.toEqual({ corrected: true });
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[0]![1].params.header["Idempotency-Key"]).toBe("original");
  expect(post.mock.calls[1]![1].params.header["Idempotency-Key"]).not.toBe("original");
  expect(post.mock.calls[1]![1].body.step_up).toBe(assertion);
});

test("an ordinary refusal never asks for a passkey or resends", async () => {
  post.mockResolvedValueOnce({ response: new Response(null, { status: 409 }), error: { error: { code: "identifier_correction_needs_exception", message: "denied" } } });
  await expect(send[0]!()).rejects.toBeInstanceOf(ApiError);
  expect(post).toHaveBeenCalledTimes(1);
});

test("voidRegistration sends Idempotency-Key and reason_code to business-registrations/{id}/void", async () => {
  post.mockResolvedValueOnce({ response: new Response(null, { status: 204 }), data: undefined });
  await expect(voidRegistration("intent-key-1", "reg-1", "DUPLICATE")).resolves.toBeUndefined();
  expect(post).toHaveBeenCalledWith("/api/v1/business-registrations/{registrationId}/void", {
    params: { path: { registrationId: "reg-1" }, header: { "Idempotency-Key": "intent-key-1" } },
    body: { reason_code: "DUPLICATE" },
  });
});


test("registration preview reads its own end-options, including server cascade data", async () => {
  const preview = { id: "reg-1", phase: "SETUP", can_manage: true, delete: { allowed: true }, revisions: 7, linked_workplaces: [] };
  get.mockResolvedValueOnce({ response: new Response(null, { status: 200 }), data: preview });
  const query = registrationEndQuery("reg-1");
  await expect(query.queryFn()).resolves.toEqual(preview);
  expect(get).toHaveBeenCalledExactlyOnceWith("/api/v1/business-registrations/{registrationId}/end-options", { params: { path: { registrationId: "reg-1" } } });
});
