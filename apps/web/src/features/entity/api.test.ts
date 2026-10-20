import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { correctIdentifier, correctRegistrationNumber } from "./api";

const post = vi.hoisted(() => vi.fn());
const assertion = vi.hoisted(() => ({ assertion: { ceremony_id: "ceremony", credential: {} } }));
vi.mock("@console/api", async (original) => ({
  ...(await original<typeof import("@console/api")>()),
  api: { POST: post },
  assertBoundPasskey: vi.fn(async () => assertion),
}));
afterEach(() => post.mockReset());
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


test.each(send)("a pending correction returns its recoverable receipt", async (correct) => {
  const pending = { status: "PENDING", exception_id: "exception", payload_hash: "a".repeat(64) };
  post.mockResolvedValueOnce({ response: new Response(null, { status: 202 }), data: pending });
  await expect(correct()).resolves.toEqual(pending);
  expect(post).toHaveBeenCalledTimes(1);
});
